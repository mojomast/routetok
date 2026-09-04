import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { serializeModelMetadata } from "../../src/model-metadata.js";
import type { CatalogModel, ModelHealth } from "../../src/types.js";
import { isolatedTestEnv, stopChild } from "../support/process.js";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(output)), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("RouteTok listening")) { clearTimeout(timer); resolve(); }
    });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.once("exit", () => reject(new Error(output)));
  });
}

test("model metadata is explicit, compatible, complete, and locally sourced", async () => {
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    if (request.url === "/agent/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-live", supported_endpoint_types: ["openai", "anthropic"], model_ratio: 1, completion_ratio: 1
      }] }));
      return;
    }
    if (request.url === "/opencode/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
      return;
    }
    if (request.url === "/openrouter/v1/models?output_modalities=all") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        base_url: "https://must-not-leak.invalid", token: "upstream-secret",
        data: [{
          id: "vendor/rich", name: "Rich Model", context_length: 131072,
          top_provider: { max_completion_tokens: 8192, base_url: "https://private.invalid" },
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools", "reasoning", "web_search"],
          pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.00000025" },
          api_key: "catalog-secret"
        }, {
          id: "vendor/missing", name: "Missing Metadata"
        }, {
          id: "vendor/free:free", name: "Free Model",
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: [], pricing: { prompt: "0", completion: "0" }
        }, {
          id: "vendor/image", name: "Image Model", context_length: 32768,
          top_provider: { max_completion_tokens: 4096 },
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          supported_parameters: ["max_tokens"], pricing: { prompt: "0.000003", completion: "0" }
        }]
      }));
      return;
    }
    if (request.url === "/requesty/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        id: "vendor/tiered", name: "Tiered Model", input_modalities: ["text"], output_modalities: ["text"],
        supported_parameters: ["tools"], pricing: [
          { prompt_tokens_threshold: 0, input_price: "0.000002", output_price: "0.000003" },
          { prompt_tokens_threshold: 100000, input_price: "0.000004", output_price: "0.000006", cache_read: "0.000001" }
        ]
      }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const root = `http://127.0.0.1:${upstreamAddress.port}`;
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-model-metadata-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
      PROXY_API_KEY: "client-secret", DASHBOARD_TOKEN: "dashboard-secret",
      AGENTROUTER_API_KEY: "agent-secret", AGENTROUTER_BASE_URL: `${root}/agent`,
      OPENROUTER_API_KEY: "openrouter-secret", OPENROUTER_BASE_URL: `${root}/openrouter/v1`,
      REQUESTY_API_KEY: "requesty-secret", REQUESTY_BASE_URL: `${root}/requesty/v1`,
      OPENCODE_ZEN_BASE_URL: `${root}/opencode`
    })
  });
  const base = `http://127.0.0.1:${port}`;
  const clientHeaders = { authorization: "Bearer client-secret" };
  const dashboardHeaders = { "x-dashboard-token": "dashboard-secret" };

  try {
    await ready(child);
    const update = await fetch(`${base}/admin/api/config`, {
      method: "PATCH", headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        enabledExternalModels: ["openrouter:vendor/rich", "openrouter:vendor/missing", "openrouter:vendor/image", "requesty:vendor/tiered"],
        openaiOrder: ["openrouter:vendor/rich", "agent-live"],
        anthropicOrder: ["agent-live", "openrouter:vendor/rich"],
        freeModelOrder: ["openrouter:vendor/free:free"],
        paidOpenRouterFallbackOrder: ["openrouter:vendor/rich"],
        customCascades: [
          { name: "local-cascade", members: ["openrouter:vendor/rich", "agent-live"] },
          { name: "openai-cascade", members: ["opencode:big-pickle"] }
        ]
      })
    });
    assert.equal(update.status, 200);

    const callsBeforeModelLists = upstreamCalls;
    const openAiDefault = await fetch(`${base}/v1/models`, { headers: clientHeaders }).then((response) => response.json()) as { object: string; data: Array<Record<string, unknown>> };
    const openAiOpted = await fetch(`${base}/v1/models?include=routetok`, { headers: clientHeaders }).then((response) => response.json()) as { object: string; data: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(openAiDefault), ["object", "data"]);
    for (const entry of openAiDefault.data) assert.deepEqual(Object.keys(entry), ["id", "object", "created", "owned_by"]);
    assert.deepEqual(openAiOpted.data.map((entry) => entry.id), openAiDefault.data.map((entry) => entry.id));
    assert.deepEqual(openAiDefault.data.map((entry) => entry.id), [
      "auto", "best", "free", "free-auto", "local-cascade", "openai-cascade", "agent-live", "openrouter:vendor/rich",
      "openrouter:vendor/missing", "openrouter:vendor/free:free", "requesty:vendor/tiered", "opencode:big-pickle"
    ]);
    assert(openAiOpted.data.every((entry) => Object.keys(entry).length === 5 && Object.hasOwn(entry, "routetok")));

    const anthropicDefault = await fetch(`${base}/v1/models`, { headers: { ...clientHeaders, "anthropic-version": "2023-06-01" } }).then((response) => response.json()) as { data: Array<Record<string, unknown>> };
    const anthropicOpted = await fetch(`${base}/v1/models?include=routetok`, { headers: { ...clientHeaders, "anthropic-version": "2023-06-01" } }).then((response) => response.json()) as { data: Array<Record<string, unknown>> };
    for (const entry of anthropicDefault.data) assert.deepEqual(Object.keys(entry), ["id", "type", "display_name", "created_at"]);
    assert.deepEqual(anthropicOpted.data.map((entry) => entry.id), anthropicDefault.data.map((entry) => entry.id));
    assert.deepEqual(anthropicDefault.data.map((entry) => entry.id), [
      "auto", "best", "free", "free-auto", "local-cascade", "agent-live", "openrouter:vendor/rich",
      "openrouter:vendor/missing", "openrouter:vendor/free:free", "requesty:vendor/tiered"
    ]);
    assert(!anthropicDefault.data.some((entry) => entry.id === "openai-cascade"));
    assert(anthropicOpted.data.every((entry) => Object.keys(entry).length === 5 && Object.hasOwn(entry, "routetok")));
    assert.equal(upstreamCalls, callsBeforeModelLists);

    const entries = new Map(openAiOpted.data.map((entry) => [String(entry.id), entry.routetok as Record<string, any>]));
    const rich = entries.get("openrouter:vendor/rich");
    assert(rich);
    assert.deepEqual(Object.keys(rich), [
      "schema_version", "route_kind", "display_name", "provider", "upstream_id", "source", "metadata_source",
      "protocols", "endpoints", "context_window_tokens", "max_output_tokens", "modalities", "capabilities",
      "supported_parameters", "pricing", "quality", "free", "access", "routing", "health"
    ]);
    assert.equal(rich.route_kind, "physical");
    assert.equal(rich.display_name, "Rich Model");
    assert.equal(rich.provider, "openrouter");
    assert.equal(rich.upstream_id, "vendor/rich");
    assert.equal(rich.source, "live");
    assert.equal(rich.metadata_source, "provider");
    assert.deepEqual(rich.protocols, ["openai", "anthropic"]);
    assert.equal(rich.endpoints, null);
    assert.equal(rich.context_window_tokens, 131072);
    assert.equal(rich.max_output_tokens, 8192);
    assert.deepEqual(rich.modalities, { input: ["text", "image"], output: ["text"] });
    assert.deepEqual(rich.capabilities, { tools: true, vision: true, audio: false, reasoning: true, caching: true, web_search: true });
    assert.deepEqual(rich.supported_parameters, ["tools", "reasoning", "web_search"]);
    assert.deepEqual(rich.pricing, {
      currency: "USD", billing_unit: "per_million_tokens", source: "provider",
      input: "1", output: "2", cache_read: "0.25", cache_write: null, tiers: null
    });
    assert.deepEqual(rich.quality, { model_ratio: 1, completion_ratio: 1 });
    assert.equal(rich.free, false);
    assert.deepEqual(rich.access, { configured: true, enabled: true, disabled: false });
    assert.deepEqual(rich.routing, { openai_rank: 1, anthropic_rank: 2, free_rank: null, paid_openrouter_rank: 1, cascade_members: [] });
    assert.deepEqual(rich.health, { openai: null, anthropic: null });

    const missing = entries.get("openrouter:vendor/missing");
    assert(missing);
    assert.equal(missing.context_window_tokens, null);
    assert.equal(missing.max_output_tokens, null);
    assert.deepEqual(missing.modalities, { input: null, output: null });
    assert.deepEqual(missing.supported_parameters, null);
    assert.deepEqual(missing.capabilities, { tools: null, vision: null, audio: null, reasoning: null, caching: null, web_search: null });
    assert.deepEqual(missing.pricing, {
      currency: null, billing_unit: null, source: "unknown",
      input: null, output: null, cache_read: null, cache_write: null, tiers: null
    });
    assert.equal(missing.free, null);

    const tiered = entries.get("requesty:vendor/tiered");
    assert(tiered);
    assert.deepEqual(tiered.pricing.tiers, [{
      prompt_tokens_threshold: 0, input: "2", output: "3", cache_read: null, cache_write: null
    }, {
      prompt_tokens_threshold: 100000, input: "4", output: "6", cache_read: "1", cache_write: null
    }]);

    assert.equal(entries.get("auto")?.route_kind, "virtual");
    assert.equal(entries.get("auto")?.source, "synthetic");
    assert.equal(entries.get("auto")?.metadata_source, "routetok");
    assert.equal(entries.get("auto")?.pricing.input, null);
    assert.equal(entries.get("auto")?.endpoints, null);
    assert.deepEqual(entries.get("auto")?.quality, { model_ratio: null, completion_ratio: null });
    assert.equal(entries.get("free")?.free, true);
    assert.equal(entries.get("free-auto")?.free, true);
    assert.equal(entries.get("local-cascade")?.route_kind, "custom_cascade");
    assert.deepEqual(entries.get("local-cascade")?.protocols, ["openai", "anthropic"]);
    assert.deepEqual(entries.get("openai-cascade")?.protocols, ["openai"]);
    assert.deepEqual(entries.get("local-cascade")?.routing.cascade_members, ["openrouter:vendor/rich", "agent-live"]);
    assert.equal(entries.get("local-cascade")?.context_window_tokens, null);
    assert.equal(entries.get("local-cascade")?.capabilities.tools, null);

    const status = await fetch(`${base}/admin/api/status`, { headers: dashboardHeaders }).then((response) => response.json()) as { catalog: { models: Array<Record<string, any>> } };
    const statusRich = status.catalog.models.find((model) => model.id === "openrouter:vendor/rich");
    assert.equal(statusRich?.metadataSource, "provider");
    assert.equal(statusRich?.pricing.unit, "per_million_tokens");

    const sandbox = await fetch(`${base}/admin/api/sandbox/catalog`, { headers: dashboardHeaders }).then((response) => response.json()) as { models: Array<Record<string, any>> };
    const sandboxRich = sandbox.models.find((model) => model.id === "openrouter:vendor/rich");
    assert.equal(sandboxRich?.source, "live");
    assert.equal(sandboxRich?.metadataSource, "provider");
    assert.deepEqual(sandboxRich?.protocols, ["openai", "anthropic"]);
    assert.equal(sandboxRich?.endpoints, null);
    assert.equal(sandboxRich?.pricing.currency, "USD");
    assert.equal(sandboxRich?.pricing.unit, "per_million_tokens");
    assert.equal(sandboxRich?.pricing.source, "provider");
    assert.equal(sandboxRich?.pricingTiers, null);
    assert.deepEqual(sandboxRich?.quality, { modelRatio: 1, completionRatio: 1 });
    const sandboxTiered = sandbox.models.find((model) => model.id === "requesty:vendor/tiered");
    assert.equal(sandboxTiered?.pricingTiers[1].promptTokensThreshold, 100000);
    assert.equal(sandboxTiered?.pricingTiers[1].input, 4);
    assert.equal(sandboxTiered?.pricingTiers[1].unit, "per_million_tokens");

    const images = await fetch(`${base}/admin/api/images/capabilities`, { headers: dashboardHeaders }).then((response) => response.json()) as { models: Array<Record<string, any>> };
    const image = images.models.find((model) => model.id === "openrouter:vendor/image");
    assert(image);
    assert.equal(image.contextTokens, 32768);
    assert.equal(image.maxOutputTokens, 4096);
    assert.equal(image.capabilities.vision, false);
    assert.deepEqual(image.protocols, ["openai", "anthropic"]);
    assert.equal(image.endpoints, null);
    assert.equal(image.source, "live");
    assert.equal(image.metadataSource, "provider");
    assert.equal(image.pricing.currency, "USD");
    assert.equal(image.pricingTiers, null);
    assert.deepEqual(image.quality, { modelRatio: 1, completionRatio: 1 });

    const callsBeforeInvalidIncludes = upstreamCalls;
    assert.equal((await fetch(`${base}/v1/models?include=unknown`, { headers: clientHeaders })).status, 400);
    assert.equal((await fetch(`${base}/v1/models?include=routetok&include=other`, { headers: clientHeaders })).status, 400);
    assert.equal(upstreamCalls, callsBeforeInvalidIncludes);

    const publicJson = JSON.stringify(openAiOpted);
    assert.doesNotMatch(publicJson, /client-secret|dashboard-secret|agent-secret|openrouter-secret|requesty-secret|catalog-secret|must-not-leak|private\.invalid/i);
    assert.doesNotMatch(JSON.stringify(sandbox), /client-secret|dashboard-secret|agent-secret|openrouter-secret|requesty-secret|catalog-secret|must-not-leak|private\.invalid/i);
    assert.doesNotMatch(JSON.stringify(images), /client-secret|dashboard-secret|agent-secret|openrouter-secret|requesty-secret|catalog-secret|must-not-leak|private\.invalid/i);
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }

  const model: CatalogModel = {
    id: "health-model", providerId: "openrouter", upstreamId: "vendor/health", protocols: ["openai"], source: "live",
    metadataSource: "provider", modelRatio: 1, completionRatio: 1,
    pricing: { input: 1e-7, output: null, cacheRead: null, cacheWrite: null, currency: "USD", unit: "per_million_tokens", source: "provider" }
  };
  const health: ModelHealth = {
    model: "health-model", protocol: "openai", successes: 4, failures: 2, consecutiveFailures: 1,
    latencyEwmaMs: 125.5, inflight: 3, circuitState: "open", circuitOpenUntil: 123456,
    rateLimitedUntil: 234567, entitlementBlocked: true, recentOutcomes: [false]
  };
  const projected = serializeModelMetadata({
    id: model.id, routeKind: "physical", model, config: DEFAULT_CONFIG,
    providerConfigured: { openrouter: true }, health: [health], free: false
  }) as Record<string, any>;
  assert.equal(projected.pricing.input, "0.0000001");
  assert.deepEqual(projected.health.openai, {
    successes: 4, failures: 2, consecutive_failures: 1, latency_ewma_ms: 125.5, in_flight: 3,
    circuit_state: "open", circuit_open_until: 123456, rate_limit_until: 234567, entitlement_blocked: true
  });
  assert.equal(projected.health.anthropic, null);
  assert.doesNotMatch(JSON.stringify(projected.health), /recent|outcome|error/i);
});
