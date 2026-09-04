import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { visibilityOf } from "../../src/model-visibility.js";
import type { CatalogModel, ProviderId, RouterConfig } from "../../src/types.js";

function configWith(overrides: Partial<RouterConfig>): RouterConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}

function baseModel(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    protocols: ["openai"],
    source: "live",
    modelRatio: 1,
    completionRatio: 1,
    ...overrides
  };
}

function freeExternalModel(id: string): CatalogModel {
  return baseModel({
    id,
    providerId: "requesty",
    protocols: ["openai"],
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: null, currency: "USD", unit: "per_million_tokens", source: "provider" }
  });
}

function configuredCtx(config: RouterConfig, ids: ProviderId[] = ["requesty", "agentrouter", "groq", "together", "openrouter"]) {
  return {
    config,
    providerConfigured: Object.fromEntries(ids.map((id) => [id, true])) as Partial<Record<ProviderId, boolean>>
  };
}

test("visible enabled free model carries no reasons", () => {
  const model = freeExternalModel("requesty:free-model");
  const result = visibilityOf(model, configuredCtx(configWith({})));
  assert.equal(result.visible, true);
  assert.deepEqual(result.reasons, []);
});

test("disabled model is hidden with disabled reason", () => {
  const model = freeExternalModel("requesty:free-model");
  const result = visibilityOf(model, configuredCtx(configWith({ disabledModels: [model.id] })));
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("disabled"));
});

test("unconfigured provider is hidden with unconfigured-provider reason", () => {
  const model = freeExternalModel("requesty:free-model");
  const result = visibilityOf(model, {
    config: configWith({}),
    providerConfigured: { agentrouter: true }
  });
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("unconfigured-provider"));
});

test("paid model not enabled is hidden with paid-needs-enable reason", () => {
  const model = baseModel({
    id: "groq:paid-model",
    providerId: "groq",
    protocols: ["openai"],
    pricing: { input: 5, output: 10, cacheRead: null, cacheWrite: null, currency: "USD", unit: "per_million_tokens", source: "provider" }
  });
  const result = visibilityOf(model, configuredCtx(configWith({ enabledExternalModels: [] })));
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("paid-needs-enable"));
});

test("unknown-price model not enabled is hidden with unknown-price-needs-enable reason", () => {
  const model = baseModel({
    id: "together:unknown-model",
    providerId: "together",
    protocols: ["openai"],
    pricing: { input: null, output: null, cacheRead: null, cacheWrite: null, currency: null, unit: null, source: "unknown" }
  });
  const result = visibilityOf(model, configuredCtx(configWith({ enabledExternalModels: [] })));
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("unknown-price-needs-enable"));
});

test("image-only model is hidden with image-only reason", () => {
  const model = baseModel({
    id: "test-image",
    providerId: "agentrouter",
    protocols: ["openai"],
    inputModalities: ["image"],
    outputModalities: ["image"]
  });
  const result = visibilityOf(model, configuredCtx(configWith({})));
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("image-only"));
});

test("non-text model is hidden with not-text-capable reason", () => {
  const model = baseModel({
    id: "test-output",
    providerId: "agentrouter",
    protocols: ["openai"],
    inputModalities: ["text"],
    outputModalities: ["image"]
  });
  const result = visibilityOf(model, configuredCtx(configWith({})));
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("not-text-capable"));
});

test("multi-reason model carries every applicable reason", () => {
  const model = baseModel({
    id: "groq:bad-model",
    providerId: "groq",
    protocols: ["openai"],
    inputModalities: ["image"],
    outputModalities: ["image"],
    pricing: { input: 5, output: 10, cacheRead: null, cacheWrite: null, currency: "USD", unit: "per_million_tokens", source: "provider" }
  });
  const result = visibilityOf(model, {
    config: configWith({ disabledModels: [model.id], enabledExternalModels: [] }),
    providerConfigured: {}
  });
  assert.equal(result.visible, false);
  assert.ok(result.reasons.includes("unconfigured-provider"));
  assert.ok(result.reasons.includes("disabled"));
  assert.ok(result.reasons.includes("paid-needs-enable"));
  assert.ok(result.reasons.includes("image-only"));
  assert.ok(result.reasons.includes("not-text-capable"));
  assert.ok(result.reasons.length >= 2);
});

test("unknown capability metadata stays visible", () => {
  const model = baseModel({
    id: "test-unknown",
    providerId: "agentrouter",
    protocols: ["openai"],
    capabilities: { tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null }
  });
  const result = visibilityOf(model, configuredCtx(configWith({})));
  assert.equal(result.visible, true);
  assert.deepEqual(result.reasons, []);
});
