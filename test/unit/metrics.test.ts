import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MetricsStore } from "../../src/metrics.js";

test("persisted metrics normalize malformed numeric fields and discard invalid records", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-metrics-normalize-"));
  try {
    const timestamp = "2026-09-03T00:00:00.000Z";
    await writeFile(path.join(dataDir, "metrics.json"), JSON.stringify({
      totals: { requests: 2, successes: -4, reportedCostUsd: 3, estimatedCostUsd: 2, costUsd: "bad" },
      byModel: {
        "openai:good": { attempts: 2, successes: 1, failures: -1, errors: { timeout: 2, bad: -1 } },
        "openai:invalid": "not-an-object"
      },
      recent: [{
        id: "request-1", timestamp, protocol: "openai", path: "/v1/responses", requestedModel: "good",
        selectedModel: "good", stream: false, status: 200, durationMs: -8, ttftMs: "bad",
        generationDurationMs: null, outputTokensPerSecond: -1,
        attempts: [{ model: "good", status: 200, durationMs: -5, firstOutputMs: "bad", outcome: "success" }],
        usage: { input: 4, output: -2, cacheRead: "bad", cacheWrite: 1, costCny: -1, estimatedCostUsd: 2, reportedCostUsd: 0 },
        error: 12
      }, { id: "invalid" }],
      series: [{ timestamp, requestId: "request-1", protocol: "openai", model: "good", provider: "agentrouter", status: -1, success: true, attempts: 1, durationMs: -1 }]
    }));

    const store = new MetricsStore(dataDir);
    await store.load();
    const snapshot = store.snapshot([]);
    assert.equal(snapshot.totals.successes, 0);
    assert.equal(snapshot.totals.costUsd, 5);
    assert.equal(snapshot.totals.upstreamAttempts, 2);
    assert.deepEqual(Object.keys(snapshot.byModel), ["openai:good"]);
    assert.deepEqual(snapshot.byModel["openai:good"]?.errors, { timeout: 2 });
    assert.equal(snapshot.recent.length, 1);
    assert.equal(snapshot.recent[0]?.durationMs, 0);
    assert.equal(snapshot.recent[0]?.usage.output, 0);
    assert.equal(snapshot.recent[0]?.ttftMs, 0);
    assert.equal(snapshot.recent[0]?.error, null);
    assert.equal(store.history().samples[0]?.status, 0);
    assert.equal(store.history().samples[0]?.durationMs, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
