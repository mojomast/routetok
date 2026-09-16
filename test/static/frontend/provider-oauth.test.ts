import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard exposes the provider OAuth connection contract", async () => {
  const script = await readFile("public/app.js", "utf8");
  assert.match(script, /function renderOAuthRow/);
  assert.match(script, /provider\.oauth\?\.supported/);
  assert.match(script, /data-oauth-start/);
  assert.match(script, /oauthMethod/);
  assert.match(script, /data-oauth-cancel/);
  assert.match(script, /data-oauth-disconnect/);
  assert.match(script, /\/oauth\/start/);
  assert.match(script, /\/oauth\/status/);
  assert.match(script, /\/oauth\/cancel/);
  assert.match(script, /window\.open\(/);
  assert.match(script, /function pollProviderOAuth/);
});
