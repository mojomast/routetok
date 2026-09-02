import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderCredentialStore } from "../../src/provider-credentials.js";
import type { ProviderRuntime } from "../../src/types.js";

test("provider credentials are write-only, persistent, and owner protected", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentrouter-credentials-"));
  const providers: ProviderRuntime[] = [
    { id: "openrouter", configured: true, apiKey: "environment-key", baseUrl: "https://example.test" },
    { id: "opencode", configured: true, apiKey: "public", baseUrl: "https://example.test" }
  ];
  try {
    const store = new ProviderCredentialStore(dataDir, providers, {
      openrouter: { apiKey: "environment-key" }, opencode: { apiKey: null }
    });
    await store.load();
    assert.equal(store.status("openrouter")[0]?.credentials.apiKey?.source, "environment");
    const status = await store.update("openrouter", "apiKey", { value: "stored-secret-key" });
    assert.equal(status.credentials.apiKey?.source, "stored");
    assert.equal(providers[0]?.apiKey, "stored-secret-key");
    assert.doesNotMatch(JSON.stringify(status), /stored-secret-key/);
    const file = path.join(dataDir, "secrets", "provider-credentials.json");
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /stored-secret-key/);
    await store.remove("openrouter", "apiKey");
    assert.equal(providers[0]?.configured, false);
    assert.equal(store.status("openrouter")[0]?.credentials.apiKey?.source, "disabled");
    await store.remove("opencode", "apiKey");
    assert.equal(providers[1]?.apiKey, "public");
    assert.equal(providers[1]?.configured, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
