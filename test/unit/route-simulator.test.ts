import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { HealthRouter } from "../../src/router.js";
import { simulateRoute } from "../../src/route-simulator.js";
import type { CatalogModel, ModelHealth, Protocol, RouterConfig } from "../../src/types.js";

function baseCatalog(): CatalogModel[] {
  return [
    { id: "primary", providerId: "agentrouter", protocols: ["openai", "anthropic"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "backup", providerId: "agentrouter", protocols: ["openai", "anthropic"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "openai-only", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "no-tools", providerId: "agentrouter", protocols: ["openai", "anthropic"], source: "live", modelRatio: 1, completionRatio: 1, capabilities: { tools: false, vision: null, audio: null, reasoning: null, caching: null, webSearch: null } }
  ];
}

function baseConfig(): RouterConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    maxAttempts: 4,
    openaiOrder: ["primary", "backup", "openai-only", "no-tools"],
    anthropicOrder: ["primary", "backup", "no-tools"]
  };
}

function seedRouter(router: HealthRouter, health: ModelHealth[]): void {
  const store = router as unknown as { health: Map<string, ModelHealth> };
  store.health.clear();
  for (const entry of health) {
    store.health.set(`${entry.protocol}:${entry.model}`, structuredClone(entry));
  }
}

function eligibleIds(result: ReturnType<typeof simulateRoute>): string[] {
  return result.filter((entry) => entry.eligible).map((entry) => entry.id);
}

function checkMatchesRouter(protocol: Protocol, model: string, catalog: CatalogModel[], config: RouterConfig, health: ModelHealth[], extra?: { tools?: boolean; inputModalities?: string[]; outputModalities?: string[] }): void {
  const router = new HealthRouter();
  seedRouter(router, health);
  const requirements = extra && (extra.tools !== undefined || extra.inputModalities !== undefined || extra.outputModalities !== undefined)
    ? { tools: extra.tools ?? false, inputModalities: extra.inputModalities ?? [], outputModalities: extra.outputModalities ?? [] }
    : undefined;
  const expected = router.candidates(protocol, model, catalog, config, requirements);
  const simulated = simulateRoute({ model, protocol, ...extra }, { config, catalogModels: catalog, health });
  assert.deepEqual(eligibleIds(simulated), expected);
  const ranks = simulated.map((entry) => entry.rank);
  assert.deepEqual(ranks, ranks.map((_, index) => index + 1));
}

test("explicit model stays first even when incompatible", () => {
  const catalog = baseCatalog();
  const config = baseConfig();
  checkMatchesRouter("openai", "no-tools", catalog, config, [], { tools: true, inputModalities: [], outputModalities: [] });
  const simulated = simulateRoute({ model: "no-tools", protocol: "openai", tools: true }, { config, catalogModels: catalog, health: [] });
  assert.equal(simulated[0]?.id, "no-tools");
  assert.equal(simulated[0]?.eligible, true);
  assert.equal(simulated[0]?.providerId, "agentrouter");
});

test("virtual auto route expands in protocol order", () => {
  const catalog = baseCatalog();
  const config = baseConfig();
  checkMatchesRouter("openai", "auto", catalog, config, []);
  checkMatchesRouter("anthropic", "best", catalog, config, []);
  const simulated = simulateRoute({ model: "auto", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  assert.deepEqual(eligibleIds(simulated), ["primary", "backup", "openai-only", "no-tools"]);
});

test("custom cascade preserves member order", () => {
  const catalog = baseCatalog();
  const config: RouterConfig = { ...baseConfig(), maxAttempts: 2, customCascades: [{ name: "coding-fast", members: ["backup", "primary"] }] };
  checkMatchesRouter("openai", "coding-fast", catalog, config, []);
  const simulated = simulateRoute({ model: "coding-fast", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  assert.deepEqual(eligibleIds(simulated), ["backup", "primary"]);
});

test("paid openrouter chain prefers openrouter fallbacks then agentrouter tail", () => {
  const catalog: CatalogModel[] = [
    { id: "openrouter:qwen/primary", providerId: "openrouter", upstreamId: "qwen/primary", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 0.03, output: 0.13, cacheRead: null, cacheWrite: null } },
    { id: "openrouter:nex/backup", providerId: "openrouter", upstreamId: "nex/backup", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 0.025, output: 0.1, cacheRead: null, cacheWrite: null } },
    { id: "deepseek-v4-flash", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "glm-5.3", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 }
  ];
  const config: RouterConfig = {
    ...baseConfig(),
    maxAttempts: 4,
    openaiOrder: ["deepseek-v4-flash", "glm-5.3"],
    paidOpenRouterFallbackOrder: ["openrouter:nex/backup"],
    enabledExternalModels: ["openrouter:qwen/primary", "openrouter:nex/backup"]
  };
  checkMatchesRouter("openai", "openrouter:qwen/primary", catalog, config, []);
  const simulated = simulateRoute({ model: "openrouter:qwen/primary", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  assert.deepEqual(eligibleIds(simulated), ["openrouter:qwen/primary", "openrouter:nex/backup", "deepseek-v4-flash", "glm-5.3"]);
  assert.equal(simulated[0]?.providerId, "openrouter");
});

test("maxAttempts truncates with over-attempt-budget strikes", () => {
  const catalog = baseCatalog();
  const config: RouterConfig = { ...baseConfig(), maxAttempts: 2 };
  checkMatchesRouter("openai", "auto", catalog, config, []);
  const simulated = simulateRoute({ model: "auto", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  assert.equal(simulated.filter((entry) => entry.eligible).length, 2);
  assert.ok(simulated.some((entry) => !entry.eligible && entry.strikeReason === "over-attempt-budget"));
});

test("incompatible tool fallback is struck while unknown metadata retained", () => {
  const catalog = baseCatalog();
  const config = baseConfig();
  checkMatchesRouter("openai", "primary", catalog, config, [], { tools: true, inputModalities: [], outputModalities: [] });
  const simulated = simulateRoute({ model: "primary", protocol: "openai", tools: true }, { config, catalogModels: catalog, health: [] });
  const struck = simulated.find((entry) => entry.id === "no-tools");
  assert.equal(struck?.eligible, false);
  assert.equal(struck?.strikeReason, "incompatible");
});

test("disabled models are struck as disabled", () => {
  const catalog = baseCatalog();
  const config: RouterConfig = { ...baseConfig(), disabledModels: ["backup"] };
  checkMatchesRouter("openai", "auto", catalog, config, []);
  const simulated = simulateRoute({ model: "auto", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  assert.ok(!eligibleIds(simulated).includes("backup"));
});

test("unhealthy circuits are struck as unhealthy", () => {
  const catalog = baseCatalog();
  const config = baseConfig();
  const now = Date.now();
  const health: ModelHealth[] = [{
    model: "primary", protocol: "openai", successes: 0, failures: 3, consecutiveFailures: 3,
    latencyEwmaMs: null, inflight: 0, circuitState: "open", circuitOpenUntil: now + 60_000,
    rateLimitedUntil: null, entitlementBlocked: false, recentOutcomes: [false, false, false]
  }];
  checkMatchesRouter("openai", "auto", catalog, config, health);
  const simulated = simulateRoute({ model: "auto", protocol: "openai" }, { config, catalogModels: catalog, health });
  const struck = simulated.find((entry) => entry.id === "primary");
  assert.equal(struck?.eligible, false);
  assert.equal(struck?.strikeReason, "unhealthy");
});

test("expired-open and half-open circuits admit a single probe in simulation parity", () => {
  const catalog = baseCatalog();
  const config = baseConfig();
  const now = Date.now();
  const fixtures: ModelHealth[][] = [
    [{ model: "primary", protocol: "openai", successes: 0, failures: 3, consecutiveFailures: 3, latencyEwmaMs: null, inflight: 0, circuitState: "open", circuitOpenUntil: now - 1, rateLimitedUntil: null, entitlementBlocked: false, recentOutcomes: [false, false, false] }],
    [{ model: "primary", protocol: "openai", successes: 0, failures: 3, consecutiveFailures: 3, latencyEwmaMs: null, inflight: 1, circuitState: "open", circuitOpenUntil: now - 1, rateLimitedUntil: null, entitlementBlocked: false, recentOutcomes: [false, false, false] }],
    [{ model: "primary", protocol: "openai", successes: 0, failures: 0, consecutiveFailures: 0, latencyEwmaMs: null, inflight: 0, circuitState: "half-open", circuitOpenUntil: null, rateLimitedUntil: null, entitlementBlocked: false, recentOutcomes: [] }],
    [{ model: "primary", protocol: "openai", successes: 0, failures: 0, consecutiveFailures: 0, latencyEwmaMs: null, inflight: 1, circuitState: "half-open", circuitOpenUntil: null, rateLimitedUntil: null, entitlementBlocked: false, recentOutcomes: [] }]
  ];
  for (const health of fixtures) {
    checkMatchesRouter("openai", "auto", catalog, config, health);
    const simulated = simulateRoute({ model: "auto", protocol: "openai" }, { config, catalogModels: catalog, health });
    const admitted = eligibleIds(simulated).includes("primary");
    assert.equal(admitted, health[0]?.inflight === 0, "half-open admission is gated on zero in-flight probes");
  }
});

test("unenabled paid external model is struck as unconfigured-provider", () => {
  const catalog: CatalogModel[] = [
    ...baseCatalog(),
    { id: "requesty:paid", providerId: "requesty", upstreamId: "paid", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 1, output: 2, cacheRead: null, cacheWrite: null } }
  ];
  const config: RouterConfig = { ...baseConfig(), enabledExternalModels: [] };
  checkMatchesRouter("openai", "requesty:paid", catalog, config, []);
  const simulated = simulateRoute({ model: "requesty:paid", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  const struck = simulated.find((entry) => entry.id === "requesty:paid");
  assert.equal(struck?.eligible, false);
  assert.equal(struck?.strikeReason, "unconfigured-provider");
});

test("free virtual route only includes zero-cost external models", () => {
  const catalog: CatalogModel[] = [
    {
      id: "openrouter:best-free:free", providerId: "openrouter", upstreamId: "best-free:free",
      protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1,
      inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["max_tokens"],
      capabilities: { tools: true, vision: false, audio: false, reasoning: true, caching: false, webSearch: false },
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    {
      id: "openrouter:paid", providerId: "openrouter", upstreamId: "paid",
      protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1,
      pricing: { input: 1, output: 2, cacheRead: null, cacheWrite: null }
    },
    ...baseCatalog()
  ];
  const config: RouterConfig = { ...baseConfig(), freeModelOrder: [], enabledExternalModels: [] };
  checkMatchesRouter("openai", "free", catalog, config, []);
  const simulated = simulateRoute({ model: "free", protocol: "openai" }, { config, catalogModels: catalog, health: [] });
  assert.deepEqual(eligibleIds(simulated), ["openrouter:best-free:free"]);
});
