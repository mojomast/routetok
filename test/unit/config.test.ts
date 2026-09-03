import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../../src/config.js";

test("configuration previews are strict and side-effect free", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentrouter-config-test-"));
  try {
    const store = new ConfigStore(dataDir);
    const original = store.get();
    const candidate = store.preview({ maxAttempts: 2 });
    assert.equal(candidate.maxAttempts, 2);
    assert.deepEqual(store.get(), original);
    assert.throws(() => store.preview({ maxAttempts: 2.5 }), /integer/);
    assert.throws(() => store.preview({ inventedSetting: true }), /Unknown configuration field/);
    assert.deepEqual(store.preview({ paidOpenRouterFallbackOrder: [" openrouter:nex/model ", "openrouter:nex/model"] }).paidOpenRouterFallbackOrder, ["openrouter:nex/model"]);
    assert.throws(() => store.preview({ paidOpenRouterFallbackOrder: ["deepseek-v4-flash"] }), /only namespaced OpenRouter/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("revision-checked updates reject stale configuration proposals", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentrouter-config-revision-test-"));
  try {
    const store = new ConfigStore(dataDir);
    const revision = store.revision();
    await store.updateIfRevision({ maxAttempts: 2 }, revision);
    await assert.rejects(store.updateIfRevision({ maxAttempts: 3 }, revision), /changed after/);
    assert.equal(store.get().maxAttempts, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("custom cascades validate names, members, and recursion", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentrouter-cascade-test-"));
  try {
    const store = new ConfigStore(dataDir);
    const candidate = store.preview({ customCascades: [{ name: "coding-fast", members: ["model-a", "model-b"] }] });
    assert.deepEqual(candidate.customCascades, [{ name: "coding-fast", members: ["model-a", "model-b"] }]);
    assert.throws(() => store.preview({ customCascades: [{ name: "auto", members: ["model-a"] }] }), /Invalid custom cascade name/);
    assert.throws(() => store.preview({ customCascades: [{ name: "one", members: ["two"] }, { name: "two", members: ["model-a"] }] }), /cannot contain other/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
