import assert from "node:assert/strict";
import test from "node:test";
import { validImage } from "../../src/admin-images.js";

const svg = (body: string) => validImage(Buffer.from(body, "utf8"), "image/svg+xml");

test("binary signatures keep their existing gate", () => {
  assert.equal(validImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "image/png"), true);
  assert.equal(validImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"), true);
  assert.equal(validImage(Buffer.from("RIFFxxxxWEBP"), "image/webp"), true);
  assert.equal(validImage(Buffer.from("not an image"), "image/svg+xml"), false);
  assert.equal(validImage(Buffer.from(""), "image/png"), false);
});

test("benign SVGs pass the gate", () => {
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'), true);
  assert.equal(svg('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#4F46E5"/><circle cx="50" cy="50" r="20" fill="white"/></svg>'), true);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="grad"><stop offset="0" stop-color="red"/></linearGradient></defs><rect style="fill:url(#grad)" width="10" height="10"/></svg>'), true, "internal url(#...) references and style attributes stay allowed");
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><a href="#frag"><text>link</text></a><use href="#sym"/></svg>'), true, "fragment references stay allowed");
});

test("processing instructions and CSS active content are rejected", () => {
  assert.equal(svg('<?xml-stylesheet href="https://evil.example/style.xsl" type="text/xsl"?><svg xmlns="http://www.w3.org/2000/svg"/>'), false, "an xml-stylesheet PI must not double as the xml declaration");
  assert.equal(svg('<?xml version="1.0"?><?xml-stylesheet href="data:text/css,..."?><svg xmlns="http://www.w3.org/2000/svg"/>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css);</style></svg>'), false, "a style element is rejected");
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><style>path { fill: red; }</style><path d="M0 0"/></svg>'), false, "any style element is rejected, not just importing ones");
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>@import'), false);
});

test("external references on a, image, use, and feImage are rejected", () => {
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.example"><text>t</text></a></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="//evil.example/steal"><text>t</text></a></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>t</text></a></svg>'), false, "javascript: hrefs are rejected");
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/payload.png" width="10" height="10"/></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA" width="10" height="10"/></svg>'), false, "data: hrefs are rejected");
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><image src="local.png" width="10" height="10"/></svg>'), false, "relative external references are rejected");
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><use href="sprite.svg#icon"/></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><feImage href="https://evil.example/f.png"/></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><feImage xlink:href="evil.example/f.png"/></svg>'), false);
});

test("legacy negatives are preserved", () => {
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.example"/></foreignObject></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><embed src="https://evil.example/x.swf"/></svg>'), false);
  assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"><object data="https://evil.example"/></svg>'), false);
  assert.equal(svg('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'), false);
  assert.equal(svg('<!ENTITY xxe SYSTEM "file:///etc/passwd"><svg xmlns="http://www.w3.org/2000/svg"/>'), false);
});
