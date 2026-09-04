import assert from "node:assert/strict";
import test from "node:test";
import { CatalogService, isFreeExternalCatalogModel, parseOpenAiCompatibleCatalog, parseOpenRouterCatalog, parseRequestyCatalog } from "../../src/catalog.js";
import type { ProviderRuntime } from "../../src/types.js";

const genericProvider: ProviderRuntime = {
  id: "generic", configured: true, apiKey: "test", baseUrl: "https://generic.invalid/v1"
};

test("OpenRouter preserves rich, missing, and explicitly empty metadata", () => {
  const [rich, missing, empty] = parseOpenRouterCatalog({ data: [
    {
      id: "vendor/rich",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning", "web_search"],
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0" }
    },
    { id: "vendor/missing" },
    {
      id: "vendor/empty",
      architecture: { input_modalities: [], output_modalities: [] },
      supported_parameters: [],
      pricing: { input_cache_read: null, input_cache_write: "invalid" }
    }
  ] });

  assert.deepEqual(rich?.inputModalities, ["text", "image"]);
  assert.deepEqual(rich?.supportedParameters, ["tools", "reasoning", "web_search"]);
  assert.deepEqual(rich?.capabilities, {
    tools: true, vision: true, audio: false, reasoning: true, caching: true, webSearch: true
  });
  assert.deepEqual(rich?.pricing, {
    input: 1, output: 2, cacheRead: 0, cacheWrite: null,
    currency: "USD", unit: "per_million_tokens", source: "provider"
  });
  assert.equal(rich?.metadataSource, "provider");

  assert.equal(missing?.inputModalities, undefined);
  assert.equal(missing?.outputModalities, undefined);
  assert.equal(missing?.supportedParameters, undefined);
  assert.deepEqual(missing?.capabilities, {
    tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null
  });
  assert.deepEqual(missing?.pricing, {
    input: null, output: null, cacheRead: null, cacheWrite: null,
    currency: null, unit: null, source: "unknown"
  });

  assert.deepEqual(empty?.inputModalities, []);
  assert.deepEqual(empty?.outputModalities, []);
  assert.deepEqual(empty?.supportedParameters, []);
  assert.deepEqual(empty?.capabilities, {
    tools: false, vision: false, audio: false, reasoning: false, caching: null, webSearch: false
  });
});

test("Requesty retains explicit flags, parameter arrays, and every pricing tier", () => {
  const [model] = parseRequestyCatalog([{
    id: "vendor/tiered",
    input_modalities: [],
    output_modalities: [],
    supported_parameters: [],
    capabilities: ["reasoning", "web_search"],
    supports_tool_calling: false,
    supports_vision: true,
    supports_caching: false,
    pricing: [
      { prompt_tokens_threshold: 100_000, input_price: "0.000002", output_price: "0.000004", cache_read: "0.000001" },
      { prompt_tokens_threshold: 0, input_price: "0", output_price: "0.000003", cache_write: "0" }
    ]
  }]);

  assert.deepEqual(model?.supportedParameters, []);
  assert.deepEqual(model?.inputModalities, []);
  assert.deepEqual(model?.capabilities, {
    tools: false, vision: true, audio: false, reasoning: true, caching: false, webSearch: true
  });
  assert.equal(model?.pricing?.input, 0);
  assert.equal(model?.pricing?.cacheWrite, 0);
  assert.deepEqual(model?.pricingTiers, [
    {
      promptTokensThreshold: 0,
      input: 0, output: 3, cacheRead: null, cacheWrite: 0,
      currency: "USD", unit: "per_million_tokens", source: "provider"
    },
    {
      promptTokensThreshold: 100_000,
      input: 2, output: 4, cacheRead: 1, cacheWrite: null,
      currency: "USD", unit: "per_million_tokens", source: "provider"
    }
  ]);
});

test("Requesty missing metadata remains unknown while explicit empty arrays remain empty", () => {
  const [missing, empty] = parseRequestyCatalog([
    { id: "vendor/missing", pricing: { cached_price: null, cache_write: "bad" } },
    { id: "vendor/empty", input_modalities: [], output_modalities: [], supported_parameters: [], capabilities: [] }
  ]);

  assert.equal(missing?.inputModalities, undefined);
  assert.equal(missing?.outputModalities, undefined);
  assert.equal(missing?.supportedParameters, undefined);
  assert.deepEqual(missing?.capabilities, {
    tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null
  });
  assert.deepEqual(empty?.inputModalities, []);
  assert.deepEqual(empty?.outputModalities, []);
  assert.deepEqual(empty?.supportedParameters, []);
  assert.deepEqual(empty?.capabilities, {
    tools: false, vision: false, audio: false, reasoning: false, caching: false, webSearch: false
  });
});

test("generic catalogs parse cache aliases without inventing absent metadata", () => {
  const [priced, missing, empty] = parseOpenAiCompatibleCatalog({ data: [
    {
      id: "priced",
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_parameters: [],
      pricing: {
        currency: "USD",
        unit: "per_token",
        prompt: "0.000001",
        completion: "0.000002",
        input_cache_read: "invalid",
        cache_read_input_token_cost: "0",
        cache_creation_input_token_cost: "0.0000005"
      }
    },
    { id: "missing" },
    { id: "empty", input_modalities: [], output_modalities: [], supported_parameters: [] }
  ] }, genericProvider);

  assert.deepEqual(priced?.pricing, {
    input: 1, output: 2, cacheRead: 0, cacheWrite: 0.5,
    currency: "USD", unit: "per_million_tokens", source: "provider"
  });
  assert.equal(priced?.capabilities?.caching, true);
  assert.equal(missing?.inputModalities, undefined);
  assert.equal(missing?.supportedParameters, undefined);
  assert.deepEqual(missing?.pricing, {
    input: null, output: null, cacheRead: null, cacheWrite: null,
    currency: null, unit: null, source: "unknown"
  });
  assert.deepEqual(empty?.inputModalities, []);
  assert.deepEqual(empty?.outputModalities, []);
  assert.deepEqual(empty?.supportedParameters, []);

  const [ambiguous] = parseOpenAiCompatibleCatalog({ data: [{ id: "ambiguous", pricing: { input: 2, output: 4 } }] }, genericProvider);
  assert.deepEqual(ambiguous?.pricing, {
    input: null, output: null, cacheRead: null, cacheWrite: null,
    currency: null, unit: null, source: "unknown"
  });
});

test("tiered pricing must be zero at every tier before a Requesty model is free", () => {
  const [tiered] = parseRequestyCatalog([{ id: "vendor/not-free", pricing: [
    { prompt_tokens_threshold: 0, input_price: "0", output_price: "0" },
    { prompt_tokens_threshold: 100_000, input_price: "0.000001", output_price: "0.000002" }
  ] }]);
  assert.equal(isFreeExternalCatalogModel(tiered!), false);
});

test("curated, mixed, live ratio, and fallback catalogs identify metadata provenance", async () => {
  const kimi = new CatalogService([{
    id: "kimi", configured: true, apiKey: "test", baseUrl: "https://kimi.invalid/v1"
  }], async () => { throw new Error("Kimi catalog must not call a provider"); });
  await kimi.refresh();
  assert.equal(kimi.getModels()[0]?.metadataSource, "curated");
  assert.equal(kimi.getModels()[0]?.pricing?.source, "unknown");

  const opencode = new CatalogService([{
    id: "opencode", configured: true, apiKey: "", auth: "none", baseUrl: "https://opencode.invalid"
  }], async () => Response.json({ data: [{ id: "big-pickle" }] }));
  await opencode.refresh();
  assert.equal(opencode.resolve("opencode:big-pickle")?.metadataSource, "mixed");
  assert.equal(opencode.resolve("opencode:big-pickle")?.pricing?.source, "curated");

  const agent = new CatalogService("https://agentrouter.invalid", async () => Response.json({
    data: [{ model_name: "live-model", supported_endpoint_types: ["openai"], model_ratio: 2, completion_ratio: 3 }]
  }));
  assert.equal(agent.getModels()[0]?.metadataSource, "fallback");
  assert.equal(agent.getModels()[0]?.inputModalities, undefined);
  await agent.refresh();
  const live = agent.resolve("live-model");
  assert.equal(live?.metadataSource, "provider");
  assert.equal(live?.contextTokens, undefined);
  assert.equal(live?.inputModalities, undefined);
  assert.deepEqual(live?.pricing, {
    input: null, output: null, cacheRead: null, cacheWrite: null,
    currency: null, unit: null, source: "unknown"
  });
});
