import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("concurrent client key mutations enforce the limit and serialize revocation", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-client-key-races-"));
  try {
    const directory = path.join(dataDir, "secrets");
    await mkdir(directory, { recursive: true });
    const keys = Array.from({ length: 63 }, (_, index) => ({
      id: randomUUID(),
      label: `Existing ${index}`,
      hash: createHash("sha256").update(`secret-${index}`).digest("hex"),
      createdAt: new Date(1_700_000_000_000 + index).toISOString()
    }));
    await writeFile(path.join(directory, "client-api-keys.json"), JSON.stringify({ version: 1, keys }));

    const store = new ClientApiKeyStore(dataDir);
    await store.load();
    const creates = await Promise.allSettled([
      store.create({ label: "Concurrent A" }),
      store.create({ label: "Concurrent B" })
    ]);
    assert.equal(creates.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(creates.filter((result) => result.status === "rejected").length, 1);
    assert.equal(store.list().length, 64);
    assert.match(String(creates.find((result) => result.status === "rejected")?.reason), /limit reached/);

    const target = store.list()[0]!;
    const revokes = await Promise.allSettled([store.revoke(target.id), store.revoke(target.id)]);
    assert.equal(revokes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(revokes.filter((result) => result.status === "rejected").length, 1);
    assert.equal(store.list().some((key) => key.id === target.id), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
