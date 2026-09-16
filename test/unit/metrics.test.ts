import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MetricsStore } from "../../src/metrics.js";
import { HealthRouter } from "../../src/router.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { RequestRecord } from "../../src/types.js";

test("Prometheus families have metadata and prefix aliases preserve escaped model labels", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-metrics-prometheus-"));
  const store = new MetricsStore(dataDir);
  try {
    const model = 'agentrouter_router_model"\\\n';
    const router = new HealthRouter();
    router.recordSuccess("openai", model, 250, DEFAULT_CONFIG);
    store.record({
      id: "prometheus-1", timestamp: new Date().toISOString(), protocol: "openai",
      path: "/v1/chat/completions", requestedModel: model, selectedModel: model,
      stream: false, status: 200, durationMs: 250, ttftMs: null,
      generationDurationMs: null, outputTokensPerSecond: null,
      attempts: [{ model, status: 200, durationMs: 250, firstOutputMs: null, outcome: "success" }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costCny: 0, estimatedCostUsd: 0 },
      error: null
    });
    const lines = store.prometheus(router.snapshot()).trim().split("\n");
    for (const line of lines.filter((line) => !line.startsWith("#"))) {
      const name = line.split(/[ {]/)[0]!;
      assert.equal(lines.filter((entry) => entry.startsWith(`# HELP ${name} `)).length, 1, name);
      assert.equal(lines.filter((entry) => entry.startsWith(`# TYPE ${name} `)).length, 1, name);
    }
    const legacy = lines.filter((line) => line.startsWith("agentrouter_router_"));
    for (const line of legacy) {
      assert.ok(lines.includes(line.replace(/^agentrouter_router_/, "routetok_")), "alias must preserve values and labels");
    }
    const escaped = model.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
    assert.ok(lines.includes(`routetok_model_attempts_total{model="${escaped}",protocol="openai"} 1`));
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

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

test("record persistence is debounced and coalesced under mock timers", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-metrics-debounce-"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const file = path.join(dataDir, "metrics.json");
    const store = new MetricsStore(dataDir);
    await store.load();
    const base = {
      timestamp: "2026-09-05T00:00:00.000Z",
      protocol: "openai" as const,
      path: "/v1/chat/completions",
      requestedModel: "m",
      selectedModel: "m" as string | null,
      stream: false,
      status: 200,
      durationMs: 1,
      ttftMs: null as number | null,
      generationDurationMs: null as number | null,
      outputTokensPerSecond: null as number | null,
      attempts: [] as RequestRecord["attempts"],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costCny: 0, estimatedCostUsd: 0 },
      error: null as string | null,
      trafficClass: "client" as const
    };
    store.record({ ...base, id: "debounce-1" });
    store.record({ ...base, id: "debounce-2" });
    assert.equal(existsSync(file), false, "no save may fire before the debounce window");
    await t.mock.timers.tick(500);
    assert.equal(existsSync(file), false, "the debounce must not fire at half the window");
    await t.mock.timers.tick(500);
    for (let attempt = 0; attempt < 5_000 && !existsSync(file); attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(existsSync(file), true, "the coalesced save must persist after one debounce window");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.totals.requests, 2, "both records must be present in the single coalesced write");
    await store.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
