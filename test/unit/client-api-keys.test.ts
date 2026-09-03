import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientApiKeyStore } from "../../src/client-api-keys.js";

test("managed client keys persist only hashes and revoke immediately", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-client-keys-"));
  try {
    const store = new ClientApiKeyStore(dataDir);
    await store.load();
    const created = await store.create({ label: "CI agent" });
    assert.match(created.secret, /^rtk_[A-Za-z0-9_-]{43}$/);
    assert.equal(store.matches(created.secret), true);
    assert.equal(store.matches(`${created.secret}x`), false);
    assert.deepEqual(store.list(), [created.key]);

    const filePath = path.join(dataDir, "secrets", "client-api-keys.json");
    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, new RegExp(created.secret));
    assert.match(persisted, /"hash": "[0-9a-f]{64}"/);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);

    const reloaded = new ClientApiKeyStore(dataDir);
    await reloaded.load();
    assert.equal(reloaded.matches(created.secret), true);
    await reloaded.revoke(created.key.id);
    assert.equal(reloaded.matches(created.secret), false);
    assert.deepEqual(reloaded.list(), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
