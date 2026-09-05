import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sandbox = readFileSync(join(root, "public", "sandbox.js"), "utf8");

test("artifact and Studio preview sanitization share one attribute deny list", () => {
  assert.match(sandbox, /function stripUnsafeAttributes\(root, options = \{\}\)/);
  const denyList = sandbox.match(/\["action", "formaction", "srcdoc", "srcset"\]/) ?? null;
  assert.ok(denyList, "the shared deny list must contain action, formaction, srcdoc, and srcset");
  assert.match(sandbox, /\/\^on\/i\.test\(name\)/);
  assert.equal((sandbox.match(/stripUnsafeAttributes\(/g) || []).length, 4,
    "the helper must be defined once and applied to the SVG artifact, HTML artifact, and Studio preview paths");
  assert.match(sandbox, /stripUnsafeAttributes\(root, \{ includeRoot: true \}\)/);
  assert.match(sandbox, /stripUnsafeAttributes\(parsed\)/);
  assert.match(sandbox, /stripUnsafeAttributes\(parsed, \{ imagesOnly: true \}\)/);
  assert.equal((sandbox.match(/for \(const attribute of \[\.\.\.element\.attributes\]\)/g) || []).length, 1,
    "no inline attribute loops may remain outside the shared helper");
});
