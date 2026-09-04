import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  apiSetup: "public/api-setup.js"
} as const;

async function loadApiSetup(): Promise<string> {
  return readFile(files.apiSetup, "utf8");
}

test("api setup exposes a mountable drawer module", async () => {
  const script = await loadApiSetup();
  assert.match(script, /window\.ApiSetup\s*=/);
  assert.match(script, /function mount\(el,/);
  assert.match(script, /fetchWithAuth/);
  assert.match(script, /baseUrl/);
  assert.match(script, /getBaseUrl\(\)/);
  assert.match(script, /unmount\(\)/);
});

test("copy targets cover base URL, every endpoint, and the curl example", async () => {
  const script = await loadApiSetup();
  assert.match(script, /data-api-setup-copy/);
  assert.match(script, /data-api-setup-copy", "base-url"/);
  assert.match(script, /data-api-setup-copy", "curl"/);
  assert.match(script, /endpoint:\$\{endpoint\.id\}/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /baseUrl \+ endpoint\.path/);
  assert.match(script, /ROUTETOK_PROXY_KEY/);
  assert.match(script, /Authorization: Bearer \$ROUTETOK_PROXY_KEY/);
});

test("endpoint references cover chat, responses, anthropic, and model listing", async () => {
  const script = await loadApiSetup();
  assert.match(script, /\/chat\/completions/);
  assert.match(script, /\/responses/);
  assert.match(script, /\/messages/);
  assert.match(script, /\/models/);
  assert.match(script, /Chat Completions/);
  assert.match(script, /Anthropic Messages/);
  assert.match(script, /List Models/);
  assert.match(script, /location\.origin.*\/v1/);
});

test("test request renders model count and clean 401 remediation", async () => {
  const script = await loadApiSetup();
  assert.match(script, /baseUrl \+ "\/models"/);
  assert.match(script, /Authorization/);
  assert.match(script, /Bearer " \+ currentKey/);
  assert.match(script, /response\.status === 401/);
  assert.match(script, /response\.json\(\)/);
  assert.match(script, /payload\.data/);
  assert.match(script, /models advertised/);
  assert.match(script, /HTTP 200/);
  assert.match(script, /rtk_/);
  assert.match(script, /x-api-key/);
  assert.match(script, /revoke that entry and create a replacement/);
});

test("pasted keys use a password field, are cleared, and never persist, render, or log", async () => {
  const script = await loadApiSetup();
  assert.match(script, /type = "password"/);
  assert.match(script, /autocomplete", "off"/);
  assert.match(script, /\.value = ""/);
  assert.match(script, /currentKey = ""/);
  assert.match(script, /data-api-setup-section", "client-keys"/);
  assert.match(script, /data-api-setup-section", "provider-credentials"/);
  assert.match(script, /Client keys authorize applications calling this proxy/);
  assert.match(script, /Provider credentials authorize RouteTok to call upstream services/);
  assert.doesNotMatch(script, /localStorage/);
  assert.doesNotMatch(script, /sessionStorage/);
  assert.doesNotMatch(script, /console\./);
  assert.doesNotMatch(script, /innerHTML/);
  assert.doesNotMatch(script, /outerHTML/);
  assert.doesNotMatch(script, /insertAdjacentHTML/);
  assert.doesNotMatch(script, /process\.env/);
  assert.doesNotMatch(script, /document\.cookie/);
});
