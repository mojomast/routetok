import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { parseOpenAiCompatibleCatalog, parseOpenRouterCatalog, parseRequestyCatalog } from "../../src/catalog.js";
import {
  StreamInspector,
  StreamSanitizer,
  shouldStripThinkingForRequestedModel,
  stripThinkingForFallback,
  thinkingPinnedModel
} from "../../src/proxy.js";
import { HealthRouter } from "../../src/router.js";
import type { CatalogModel } from "../../src/types.js";

const catalog: CatalogModel[] = [
  { id: "best-model", protocols: ["openai", "anthropic"], source: "live", modelRatio: 4, completionRatio: 5 },
  { id: "backup-model", protocols: ["openai", "anthropic"], source: "live", modelRatio: 1.5, completionRatio: 4 },
  { id: "openai-only", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 3 }
];

const config = {
  ...structuredClone(DEFAULT_CONFIG),
  maxAttempts: 3,
  circuitFailureThreshold: 2,
  circuitMinimumSamples: 2,
  circuitWindowSize: 4,
  openaiOrder: ["best-model", "backup-model", "openai-only"],
  anthropicOrder: ["best-model", "backup-model"]
};

test("virtual aliases follow protocol-specific quality order", () => {
  const router = new HealthRouter();
  assert.deepEqual(router.candidates("openai", "best", catalog, config), [
    "best-model",
    "backup-model",
    "openai-only"
  ]);
  assert.deepEqual(router.candidates("anthropic", "auto", catalog, config), [
    "best-model",
    "backup-model"
  ]);
});

test("named custom cascades preserve their physical member order", () => {
  const router = new HealthRouter();
  const custom = { ...config, maxAttempts: 2, customCascades: [{ name: "coding-fast", members: ["backup-model", "best-model"] }] };
  assert.deepEqual(router.candidates("openai", "coding-fast", catalog, custom), ["backup-model", "best-model"]);
  router.recordTransientFailure("openai", "backup-model", { ...custom, circuitFailureThreshold: 1 });
  assert.deepEqual(router.candidates("openai", "coding-fast", catalog, custom), ["best-model"]);
});

test("explicit models remain first while transiently failed circuits are removed", () => {
  const router = new HealthRouter();
  assert.deepEqual(router.candidates("openai", "backup-model", catalog, config), [
    "backup-model",
    "best-model",
    "openai-only"
  ]);

  router.recordTransientFailure("openai", "best-model", config);
  router.recordTransientFailure("openai", "best-model", config);
  assert.deepEqual(router.candidates("openai", "auto", catalog, config), [
    "backup-model",
    "openai-only"
  ]);
});

test("explicit models must advertise support for the incoming protocol", () => {
  const router = new HealthRouter();
  assert.deepEqual(router.candidates("anthropic", "openai-only", catalog, config), [
    "best-model",
    "backup-model"
  ]);
});

test("rate-limited and entitlement-blocked routes are suppressed", () => {
  const router = new HealthRouter();
  router.recordRateLimit("anthropic", "best-model", 60_000, config);
  assert.deepEqual(router.candidates("anthropic", "auto", catalog, config), ["backup-model"]);

  router.recordEntitlementFailure("anthropic", "backup-model", config);
  assert.deepEqual(router.candidates("anthropic", "auto", catalog, config), []);
});

function seededRouter(health: Array<{ model: string; protocol: "openai" | "anthropic"; circuitState: "closed" | "open" | "half-open"; circuitOpenUntil: number | null; inflight?: number; consecutiveFailures?: number; failures?: number; recentOutcomes?: boolean[] }>): HealthRouter {
  const router = new HealthRouter();
  const store = router as unknown as { health: Map<string, import("../../src/types.js").ModelHealth> };
  for (const entry of health) {
    store.health.set(`${entry.protocol}:${entry.model}`, {
      model: entry.model,
      protocol: entry.protocol,
      successes: 0,
      failures: entry.failures ?? 0,
      consecutiveFailures: entry.consecutiveFailures ?? 0,
      latencyEwmaMs: null,
      inflight: entry.inflight ?? 0,
      circuitState: entry.circuitState,
      circuitOpenUntil: entry.circuitOpenUntil,
      rateLimitedUntil: null,
      entitlementBlocked: false,
      recentOutcomes: entry.recentOutcomes ?? []
    });
  }
  return router;
}

test("an expired open circuit admits exactly one half-open probe and reopens on its failure", () => {
  const router = seededRouter([{
    model: "best-model", protocol: "openai", circuitState: "open", circuitOpenUntil: Date.now() - 1,
    consecutiveFailures: 3, failures: 3, recentOutcomes: [false, false, false]
  }]);
  const admitted = router.candidates("openai", "best-model", catalog, config);
  assert.equal(admitted[0], "best-model", "expired open transitions to half-open and admits a probe");
  assert.ok(admitted.length > 1, "fallback chain stays available behind the probe");

  router.startAttempt("openai", "best-model");
  const concurrent = router.candidates("openai", "best-model", catalog, config);
  assert.ok(!concurrent.includes("best-model"), "a half-open probe in flight admits no concurrent probe");
  router.finishAttempt("openai", "best-model");

  router.recordTransientFailure("openai", "best-model", config);
  const reopened = router.snapshot().find((entry) => entry.model === "best-model");
  assert.equal(reopened?.circuitState, "open");
  assert((reopened?.circuitOpenUntil ?? 0) > Date.now(), "probe failure refreshes the open window");
  assert.equal(reopened?.consecutiveFailures, 0, "the probe decision replaces any inherited failure counter");
  assert.deepEqual(reopened?.recentOutcomes, [], "window accumulation is skipped for the half-open probe");
  assert.equal(reopened?.failures, 3, "the probe failure is not re-accumulated");
  assert.ok(!router.candidates("openai", "best-model", catalog, config).includes("best-model"));
});

test("a successful half-open probe closes the circuit and clears the inherited streak", () => {
  const router = seededRouter([{
    model: "best-model", protocol: "openai", circuitState: "open", circuitOpenUntil: Date.now() - 1,
    consecutiveFailures: 7, failures: 7
  }]);
  assert.equal(router.candidates("openai", "best-model", catalog, config)[0], "best-model");
  router.startAttempt("openai", "best-model");
  router.finishAttempt("openai", "best-model");
  router.recordSuccess("openai", "best-model", 1_000, config);
  const state = router.snapshot().find((entry) => entry.model === "best-model");
  assert.equal(state?.circuitState, "closed");
  assert.equal(state?.consecutiveFailures, 0);
  assert.deepEqual(state?.recentOutcomes, [true]);
  assert.equal(state?.circuitOpenUntil, null);
});

test("rate-limited and entitlement-blocked half-open probes re-open the circuit", () => {
  const router = seededRouter([{
    model: "best-model", protocol: "openai", circuitState: "half-open", circuitOpenUntil: null, consecutiveFailures: 3
  }]);
  router.recordRateLimit("openai", "best-model", 60_000, config);
  const limited = router.snapshot().find((entry) => entry.model === "best-model");
  assert.equal(limited?.circuitState, "open");
  assert((limited?.circuitOpenUntil ?? 0) > Date.now());
  assert.equal(limited?.consecutiveFailures, 0);
  assert((limited?.rateLimitedUntil ?? 0) > Date.now(), "the rate-limit window still applies after the open period");

  const blocked = seededRouter([{
    model: "backup-model", protocol: "openai", circuitState: "half-open", circuitOpenUntil: null
  }]);
  blocked.recordEntitlementFailure("openai", "backup-model", config);
  const state = blocked.snapshot().find((entry) => entry.model === "backup-model");
  assert.equal(state?.circuitState, "open");
  assert.equal(state?.entitlementBlocked, true, "the entitlement block persists alongside the re-opened circuit");
});

test("opening via the consecutive-failure arm zeroes the carried streak", () => {
  const router = new HealthRouter();
  const hard = { ...config, circuitFailureThreshold: 2 };
  router.recordTransientFailure("openai", "best-model", hard);
  router.recordTransientFailure("openai", "best-model", hard);
  const state = router.snapshot().find((entry) => entry.model === "best-model");
  assert.equal(state?.circuitState, "open");
  assert.equal(state?.consecutiveFailures, 0, "the inherited counter cannot re-open the circuit on the next probe");
  assert.deepEqual(state?.recentOutcomes, []);
  assert.ok(!router.candidates("openai", "best-model", catalog, config).includes("best-model"));
});

test("external catalogs are normalized with canonical route IDs and USD pricing", () => {
  const openRouter = parseOpenRouterCatalog({ data: [{
    id: "vendor/model", name: "Vendor Model", context_length: 128000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["tools", "reasoning"],
    pricing: { prompt: "0.000001", completion: "0.000003", input_cache_read: "0.0000002" },
    top_provider: { max_completion_tokens: 8192 }
  }] });
  assert.equal(openRouter[0]?.id, "openrouter:vendor/model");
  assert.equal(openRouter[0]?.upstreamId, "vendor/model");
  assert.equal(openRouter[0]?.pricing?.input, 1);
  assert.equal(openRouter[0]?.pricing?.output, 3);
  assert.equal(openRouter[0]?.capabilities?.vision, true);

  const requesty = parseRequestyCatalog([{ id: "provider/chat", type: "chat", context_window: 64000,
    pricing: { input: "0.000002", output: "0.000004" } }]);
  assert.equal(requesty[0]?.id, "requesty:provider/chat");
  assert.deepEqual(requesty[0]?.protocols, ["openai", "anthropic"]);
  assert.equal(requesty[0]?.pricing?.input, 2);

  const requestyVision = parseRequestyCatalog([{ id: "provider/vision", type: "chat", supports_vision: true }]);
  assert.equal(requestyVision[0]?.inputModalities, undefined);
  assert.equal(requestyVision[0]?.capabilities?.vision, true);

  const unknownOpenRouter = parseOpenRouterCatalog({ data: [{ id: "vendor/unknown", pricing: {} }] })[0];
  assert.equal(unknownOpenRouter?.inputModalities, undefined);
  assert.equal(unknownOpenRouter?.outputModalities, undefined);
  assert.equal(unknownOpenRouter?.capabilities?.tools, null);
  assert.equal(unknownOpenRouter?.capabilities?.vision, null);
  assert.equal(unknownOpenRouter?.capabilities?.audio, null);
  assert.equal(unknownOpenRouter?.supportedParameters, undefined);

  const unknownRequesty = parseRequestyCatalog([{ id: "vendor/unknown" }])[0];
  assert.equal(unknownRequesty?.inputModalities, undefined);
  assert.equal(unknownRequesty?.outputModalities, undefined);
  assert.equal(unknownRequesty?.capabilities?.tools, null);
  assert.equal(unknownRequesty?.capabilities?.vision, null);
  assert.equal(unknownRequesty?.capabilities?.audio, null);
});

test("OpenAI-compatible provider catalogs remain namespaced and conservative", () => {
  const together = parseOpenAiCompatibleCatalog([{ id: "meta/model", type: "chat", pricing: { input: 0.2, output: 0.8 } }], { id: "together", configured: true, apiKey: "x", baseUrl: "https://example.test/v1", endpoints: ["chat"] });
  assert.equal(together[0]?.id, "together:meta/model");
  assert.equal(together[0]?.pricing?.input, 0.2);
  assert.deepEqual(together[0]?.protocols, ["openai"]);
  assert.deepEqual(together[0]?.endpoints, ["chat"]);
  const groq = parseOpenAiCompatibleCatalog({ data: [{ id: "whisper-large-v3", active: true }, { id: "llama-test", active: true }] }, { id: "groq", configured: true, apiKey: "x", baseUrl: "https://example.test/v1", endpoints: ["chat", "responses"] });
  assert.deepEqual(groq.map((model) => model.id), ["groq:llama-test"]);
  assert.equal(groq[0]?.pricing?.input, null);
});

test("auto routing includes ordered external routes but not unordered external catalogs", () => {
  const router = new HealthRouter();
  const mixed: CatalogModel[] = [
    ...catalog,
    { id: "openrouter:ordered", providerId: "openrouter", upstreamId: "ordered", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "requesty:unordered", providerId: "requesty", upstreamId: "unordered", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 }
  ];
  const mixedConfig = {
    ...config,
    openaiOrder: ["openrouter:ordered", "best-model"],
    enabledExternalModels: ["openrouter:ordered", "requesty:unordered"]
  };
  assert.deepEqual(router.candidates("openai", "auto", mixed, mixedConfig), [
    "openrouter:ordered", "best-model", "backup-model"
  ]);
  assert.equal(router.candidates("openai", "requesty:unordered", mixed, mixedConfig)[0], "requesty:unordered");
});

test("external paid models require explicit enablement while free models do not", () => {
  const router = new HealthRouter();
  const externalCatalog: CatalogModel[] = [
    {
      id: "openrouter:openrouter/free",
      providerId: "openrouter",
      upstreamId: "openrouter/free",
      protocols: ["openai"],
      source: "live",
      modelRatio: 1,
      completionRatio: 1,
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    {
      id: "requesty:openai/paid",
      providerId: "requesty",
      upstreamId: "openai/paid",
      protocols: ["openai"],
      source: "live",
      modelRatio: 1,
      completionRatio: 1,
      pricing: { input: 0.2, output: 1, cacheRead: null, cacheWrite: null }
    }
  ];
  const externalConfig = {
    ...config,
    fallbackExplicitModels: false,
    openaiOrder: [],
    enabledExternalModels: []
  };
  assert.deepEqual(router.candidates("openai", "openrouter:openrouter/free", externalCatalog, externalConfig), [
    "openrouter:openrouter/free"
  ]);
  assert.deepEqual(router.candidates("openai", "requesty:openai/paid", externalCatalog, externalConfig), []);
  assert.deepEqual(router.candidates("openai", "requesty:openai/paid", externalCatalog, {
    ...externalConfig,
    enabledExternalModels: ["requesty:openai/paid"]
  }), ["requesty:openai/paid"]);
});

test("paid OpenRouter requests use OpenRouter alternatives before AgentRouter", () => {
  const router = new HealthRouter();
  const paidCatalog: CatalogModel[] = [
    { id: "openrouter:qwen/primary", providerId: "openrouter", upstreamId: "qwen/primary", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 0.03, output: 0.13, cacheRead: null, cacheWrite: null } },
    { id: "openrouter:nex/backup", providerId: "openrouter", upstreamId: "nex/backup", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 0.025, output: 0.1, cacheRead: null, cacheWrite: null } },
    { id: "openrouter:free:free", providerId: "openrouter", upstreamId: "free:free", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 0, output: 0, cacheRead: null, cacheWrite: null } },
    { id: "requesty:other", providerId: "requesty", upstreamId: "other", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, pricing: { input: 0.02, output: 0.1, cacheRead: null, cacheWrite: null } },
    { id: "deepseek-v4-flash", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "glm-5.3", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 }
  ];
  const paidConfig = {
    ...config,
    maxAttempts: 4,
    openaiOrder: ["deepseek-v4-flash", "requesty:other", "glm-5.3"],
    paidOpenRouterFallbackOrder: ["openrouter:free:free", "requesty:other", "openrouter:nex/backup"],
    enabledExternalModels: ["openrouter:qwen/primary", "openrouter:nex/backup", "requesty:other"]
  };
  assert.deepEqual(router.candidates("openai", "openrouter:qwen/primary", paidCatalog, paidConfig), [
    "openrouter:qwen/primary", "openrouter:nex/backup", "deepseek-v4-flash", "glm-5.3"
  ]);
  assert.deepEqual(router.candidates("openai", "openrouter:qwen/primary", paidCatalog, { ...paidConfig, fallbackExplicitModels: false }), [
    "openrouter:qwen/primary", "openrouter:nex/backup", "deepseek-v4-flash", "glm-5.3"
  ]);
  assert.deepEqual(router.candidates("openai", "openrouter:qwen/primary", paidCatalog, { ...paidConfig, fallbackExplicitModels: false, paidOpenRouterFallbackOrder: [] }), ["openrouter:qwen/primary"]);
  assert.deepEqual(router.candidates("openai", "requesty:other", paidCatalog, { ...paidConfig, fallbackExplicitModels: false }), ["requesty:other"]);
  assert.equal(router.candidates("openai", "requesty:other", paidCatalog, paidConfig).includes("openrouter:nex/backup"), false);
});

test("fallback capability filtering rejects explicit conflicts but retains unknown metadata", () => {
  const router = new HealthRouter();
  const capabilityCatalog: CatalogModel[] = [
    { id: "primary", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1 },
    { id: "no-tools", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, capabilities: { tools: false, vision: null, audio: null, reasoning: null, caching: null, webSearch: null } },
    { id: "text-only", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, inputModalities: ["text"], outputModalities: ["text"], capabilities: { tools: true, vision: false, audio: false, reasoning: null, caching: null, webSearch: null } },
    { id: "metadata-unknown", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, capabilities: { tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null } },
    { id: "metadata-empty", providerId: "agentrouter", protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1, inputModalities: [], outputModalities: [], capabilities: { tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null } }
  ];
  const capabilityConfig = { ...config, maxAttempts: 4, openaiOrder: capabilityCatalog.map((model) => model.id) };
  assert.deepEqual(router.candidates("openai", "primary", capabilityCatalog, capabilityConfig, {
    tools: true, inputModalities: ["image"], outputModalities: []
  }), ["primary", "metadata-unknown"]);
});

test("free virtual route only cascades through zero-cost external models", () => {
  const router = new HealthRouter();
  const externalCatalog: CatalogModel[] = [
    {
      id: "openrouter:best-free:free",
      providerId: "openrouter",
      upstreamId: "best-free:free",
      protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1,
      inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["max_tokens", "temperature"],
      contextTokens: 1_000_000,
      capabilities: { tools: true, reasoning: true, vision: false, audio: false, caching: false, webSearch: false },
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    {
      id: "requesty:backup-free",
      providerId: "requesty",
      upstreamId: "backup-free",
      protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1,
      contextTokens: 500_000,
      capabilities: { tools: true, reasoning: true, vision: false, audio: false, caching: false, webSearch: false },
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    {
      id: "openrouter:image-zero-token-price",
      providerId: "openrouter",
      upstreamId: "vendor/image-zero-token-price",
      protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1,
      inputModalities: ["text"], outputModalities: ["image"], supportedParameters: ["prompt"],
      pricing: { input: 0, output: 0, cacheRead: null, cacheWrite: null }
    },
    {
      id: "openrouter:paid",
      providerId: "openrouter",
      upstreamId: "paid",
      protocols: ["openai"], source: "live", modelRatio: 1, completionRatio: 1,
      pricing: { input: 1, output: 2, cacheRead: null, cacheWrite: null }
    },
    ...catalog
  ];
  const freeConfig = {
    ...config,
    maxAttempts: 4,
    freeModelOrder: ["requesty:backup-free", "openrouter:paid", "openrouter:best-free:free"],
    enabledExternalModels: ["openrouter:paid"]
  };
  assert.deepEqual(router.candidates("openai", "free", externalCatalog, freeConfig), [
    "requesty:backup-free",
    "openrouter:best-free:free"
  ]);
});

test("OpenAI stream inspector tracks terminal events and usage", () => {
  const inspector = new StreamInspector("openai");
  const encoder = new TextEncoder();
  inspector.push(encoder.encode(
    'data: {"choices":[{"delta":{"content":"OK"}}],"usage":null}\n\n'
  ));
  inspector.push(encoder.encode(
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
  ));
  inspector.finish();
  assert.equal(inspector.meaningful, true);
  assert.equal(inspector.terminal, true);
  assert.equal(inspector.outputUtf8Bytes, 2);
  assert(inspector.firstTextAt !== null);
  assert.deepEqual(inspector.usage, {
    input: 3,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    costCny: 0,
    estimatedCostUsd: 0
  });
});

test("Anthropic stream inspector recognizes message completion", () => {
  const inspector = new StreamInspector("anthropic");
  const encoder = new TextEncoder();
  inspector.push(encoder.encode(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n'
  ));
  inspector.push(encoder.encode(
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n'
  ));
  inspector.push(encoder.encode(
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  ));
  inspector.finish();
  assert.equal(inspector.meaningful, true);
  assert.equal(inspector.terminal, true);
  assert.deepEqual(inspector.usage, {
    input: 7,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    costCny: 0,
    estimatedCostUsd: 0
  });
});

test("stream metadata does not commit output and Responses failures are errors", () => {
  const anthropic = new StreamInspector("anthropic");
  anthropic.push(new TextEncoder().encode(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n'
  ));
  assert.equal(anthropic.meaningful, false);

  const openai = new StreamInspector("openai");
  openai.push(new TextEncoder().encode(
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n'
  ));
  assert.equal(openai.meaningful, false);
  openai.push(new TextEncoder().encode(
    'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"failed"}}}\n\n'
  ));
  assert.equal(openai.terminal, true);
  assert.equal(openai.upstreamError, "upstream stream error");
});

test("Responses sanitizer relays flat error events and preserves their event line", () => {
  const sanitizer = new StreamSanitizer("openai", "/v1/responses", "physical-model");
  const bytes = sanitizer.push(new TextEncoder().encode(
    'event: error\ndata: {"type":"error","code":"server_error","message":"upstream boom","param":null,"sequence_number":1}\n\n'
  ));
  assert.equal(bytes.length, 1);
  const text = new TextDecoder().decode(bytes[0]);
  assert.match(text, /^event: error\ndata: /);
  assert.match(text, /"type":"error"/);
  assert.match(text, /"message":"upstream boom"/);
  assert.doesNotMatch(text, /stream_interrupted/);
  assert.equal(sanitizer.finish().length, 0);
});

test("Responses sanitizer drops only non-error unknown event types", () => {
  const sanitizer = new StreamSanitizer("openai", "/v1/responses", "physical-model");
  const relayed = sanitizer.push(new TextEncoder().encode(
    'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"failed"}}}\n\n'
  ));
  assert.equal(relayed.length, 1);
  const dropped = sanitizer.push(new TextEncoder().encode(
    'event: unknown\ndata: {"type":"unknown_type","unexpected":true}\n\n'
  ));
  assert.equal(dropped.length, 0);
  assert.equal(sanitizer.finish().length, 0);
});

test("Responses stream inspector tracks text estimates and nested final usage", () => {
  const inspector = new StreamInspector("openai");
  const encoder = new TextEncoder();
  inspector.push(encoder.encode(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
  ));
  inspector.push(encoder.encode(
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":3,"input_tokens_details":{"cached_tokens":5}}}}\n\n'
  ));
  inspector.finish();
  assert.equal(inspector.meaningful, true);
  assert.equal(inspector.terminal, true);
  assert.equal(inspector.outputUtf8Bytes, 5);
  assert.equal(inspector.usage.input, 8);
  assert.equal(inspector.usage.output, 3);
  assert.equal(inspector.usage.cacheRead, 5);
});

test("signed Anthropic thinking pins the physical Claude model", () => {
  assert.equal(thinkingPinnedModel("anthropic", {
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: []
  }, "best"), "claude-opus-5");

  assert.equal(thinkingPinnedModel("anthropic", {
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "signed-value" }]
    }]
  }, "best"), "claude-opus-5");

  assert.equal(thinkingPinnedModel("anthropic", {
    messages: [{ role: "user", content: "hello" }]
  }, "best"), null);

  assert.equal(thinkingPinnedModel("anthropic", {
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: []
  }, "deepseek-v4-flash"), null);

  const switchedHistory = {
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "private", signature: "signed-value" }]
    }]
  };
  assert.equal(
    shouldStripThinkingForRequestedModel("anthropic", switchedHistory, "deepseek-v4-flash"),
    true
  );
  assert.equal(
    shouldStripThinkingForRequestedModel("anthropic", switchedHistory, "claude-opus-5"),
    false
  );
});

test("thinking fallback strips signatures but preserves visible tool history", () => {
  const original = {
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "signed" },
          { type: "text", text: "visible" },
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "x" } }
        ]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result" }]
      },
      {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque" }]
      }
    ]
  };

  const transformed = stripThinkingForFallback(original);
  assert.equal(transformed.thinking, undefined);
  assert.deepEqual(transformed.messages, [
    {
      role: "assistant",
      content: [
        { type: "text", text: "visible" },
        { type: "tool_use", id: "tool-1", name: "read", input: { path: "x" } }
      ]
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result" }]
    }
  ]);
  assert.equal(original.messages[0]?.content[0]?.type, "thinking");
});
