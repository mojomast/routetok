import type { CatalogModel, ModelHealth, Protocol, ProviderId, RouterConfig, RoutingRequirements } from "./types.js";
import { isFreeExternalCatalogModel, isTextGenerationModel } from "./catalog.js";

export type StrikeReason = "incompatible" | "disabled" | "unhealthy" | "over-attempt-budget" | "unconfigured-provider";

export interface SimulateRouteInput {
  model: string;
  protocol?: Protocol;
  tools?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
}

export interface SimulateRouteSnapshot {
  config: RouterConfig;
  catalogModels: CatalogModel[];
  health: ModelHealth[];
}

export interface SimulatedCandidate {
  id: string;
  providerId: ProviderId;
  eligible: boolean;
  strikeReason?: StrikeReason;
  rank: number;
}

const VIRTUAL_MODELS = new Set(["auto", "best", "agentrouter-auto", "agentrouter-best", "free", "free-auto"]);

function freeModelScore(model: CatalogModel): number {
  return (model.capabilities?.reasoning ? 1_000_000_000 : 0) +
    (model.capabilities?.tools ? 500_000_000 : 0) +
    (model.contextTokens ?? 0) +
    (model.maxOutputTokens ?? 0) * 2;
}

function healthFor(health: ModelHealth[], protocol: Protocol, model: string): ModelHealth | null {
  return health.find((entry) => entry.protocol === protocol && entry.model === model) ?? null;
}

function isBlockedByHealth(state: ModelHealth | null, now: number): boolean {
  if (!state) return false;
  if (state.entitlementBlocked) return true;
  if (state.rateLimitedUntil && state.rateLimitedUntil > now) return true;
  if (state.circuitState === "open") {
    const expired = state.circuitOpenUntil !== null && state.circuitOpenUntil <= now;
    if (!expired) return true;
    return state.inflight > 0;
  }
  if (state.circuitState === "half-open") return state.inflight > 0;
  return false;
}

function score(protocol: Protocol, model: string, order: string[], health: ModelHealth[]): number {
  const state = healthFor(health, protocol, model);
  const orderIndex = order.indexOf(model);
  const base = orderIndex === -1 ? 0 : 1_000 - orderIndex * 100;
  const successes = state?.successes ?? 0;
  const failures = state?.failures ?? 0;
  const attempts = successes + failures;
  const successRate = attempts ? successes / attempts : 1;
  const latencyPenalty = state?.latencyEwmaMs === null || state?.latencyEwmaMs === undefined
    ? 0
    : Math.min(50, (state.latencyEwmaMs as number) / 1_000);
  return base + successRate * 30 - (state?.consecutiveFailures ?? 0) * 80 - (state?.inflight ?? 0) * 140 - latencyPenalty;
}

function isExplicitlyIncompatible(model: CatalogModel, requirements: RoutingRequirements): boolean {
  if (requirements.tools && model.capabilities?.tools === false) return true;
  for (const modality of requirements.inputModalities) {
    if (model.inputModalities && !model.inputModalities.includes(modality)) return true;
    if (modality === "image" && model.capabilities?.vision === false) return true;
    if (modality === "audio" && model.capabilities?.audio === false) return true;
  }
  for (const modality of requirements.outputModalities) {
    if (model.outputModalities && !model.outputModalities.includes(modality)) return true;
    if (modality === "audio" && model.capabilities?.audio === false) return true;
  }
  return false;
}

export function simulateRoute(input: SimulateRouteInput, snapshot: SimulateRouteSnapshot): SimulatedCandidate[] {
  const protocol: Protocol = input.protocol ?? "openai";
  const config = snapshot.config;
  const catalog = snapshot.catalogModels;
  const health = snapshot.health;
  const now = Date.now();
  const hasRequirements = input.tools !== undefined || input.inputModalities !== undefined || input.outputModalities !== undefined;
  const requirements: RoutingRequirements | undefined = hasRequirements
    ? { tools: input.tools ?? false, inputModalities: input.inputModalities ?? [], outputModalities: input.outputModalities ?? [] }
    : undefined;
  const requestedModel = input.model;
  const available = new Set(
    catalog
      .filter((model) => model.protocols.includes(protocol))
      .filter((model) => {
        if (!model.providerId || model.providerId === "agentrouter") return true;
        const free = isFreeExternalCatalogModel(model);
        return free || config.enabledExternalModels.includes(model.id);
      })
      .map((model) => model.id)
      .filter((model) => !config.disabledModels.includes(model))
  );
  const configuredOrder = protocol === "openai" ? config.openaiOrder : config.anthropicOrder;
  const customCascade = config.customCascades.find((cascade) => cascade.name === requestedModel);
  const freeVirtual = requestedModel === "free" || requestedModel === "free-auto";
  const requestedCatalogModel = catalog.find((model) => model.id === requestedModel);
  const paidOpenRouterRequest = !customCascade && !VIRTUAL_MODELS.has(requestedModel) && requestedCatalogModel?.providerId === "openrouter" && !isFreeExternalCatalogModel(requestedCatalogModel);
  const freeModels = catalog
    .filter((model) => model.protocols.includes(protocol))
    .filter((model) => model.providerId && model.providerId !== "agentrouter")
    .filter((model) => isFreeExternalCatalogModel(model) && isTextGenerationModel(model, protocol))
    .filter((model) => available.has(model.id));
  const freeIds = new Set(freeModels.map((model) => model.id));
  const freeOrder = [
    ...config.freeModelOrder.filter((model) => freeIds.has(model)),
    ...freeModels
      .filter((model) => !config.freeModelOrder.includes(model.id))
      .sort((left, right) => freeModelScore(right) - freeModelScore(left) || left.id.localeCompare(right.id))
      .map((model) => model.id)
  ];
  const unorderedAgentRouter = catalog
    .filter((model) => (model.providerId ?? "agentrouter") === "agentrouter")
    .map((model) => model.id);
  const standardOrder = [
    ...configuredOrder.filter((model) => available.has(model)),
    ...unorderedAgentRouter.filter((model) => available.has(model) && !configuredOrder.includes(model)).sort()
  ];
  const ordered = customCascade ? customCascade.members.filter((model) => available.has(model)) : freeVirtual ? freeOrder : standardOrder;
  const paidOpenRouterFallbacks = [
    ...config.paidOpenRouterFallbackOrder.filter((id) => {
      const model = catalog.find((entry) => entry.id === id);
      return model?.providerId === "openrouter" && !isFreeExternalCatalogModel(model) && available.has(id) && id !== requestedModel;
    }),
    ...standardOrder.filter((id) => {
      const model = catalog.find((entry) => entry.id === id);
      return available.has(id) && (model?.providerId ?? "agentrouter") === "agentrouter";
    })
  ].filter((id, index, values) => values.indexOf(id) === index);
  const explicitFallbackOrder = paidOpenRouterRequest ? paidOpenRouterFallbacks : ordered;
  const explicitFallbackEnabled = paidOpenRouterRequest ? config.paidOpenRouterFallbackOrder.length > 0 : config.fallbackExplicitModels;
  const virtual = Boolean(customCascade) || VIRTUAL_MODELS.has(requestedModel);
  let preDedup = virtual
    ? ordered
    : [
      requestedModel,
      ...(explicitFallbackEnabled ? explicitFallbackOrder.filter((model) => model !== requestedModel) : [])
    ];
  preDedup = preDedup.filter((model, index) => preDedup.indexOf(model) === index);
  const exact = virtual ? null : requestedModel;
  const struck = new Map<string, StrikeReason>();
  const passed: string[] = [];
  for (const id of preDedup) {
    if (config.disabledModels.includes(id)) {
      struck.set(id, "disabled");
      continue;
    }
    if (!available.has(id)) {
      const entry = catalog.find((entry) => entry.id === id);
      if (!entry) {
        struck.set(id, "unconfigured-provider");
        continue;
      }
      if (!entry.protocols.includes(protocol)) {
        struck.set(id, "incompatible");
        continue;
      }
      if (entry.providerId && entry.providerId !== "agentrouter" && !isFreeExternalCatalogModel(entry) && !config.enabledExternalModels.includes(id)) {
        struck.set(id, "unconfigured-provider");
        continue;
      }
      struck.set(id, "unconfigured-provider");
      continue;
    }
    const catalogModel = catalog.find((entry) => entry.id === id);
    if (requirements && id !== exact && catalogModel && isExplicitlyIncompatible(catalogModel, requirements)) {
      struck.set(id, "incompatible");
      continue;
    }
    const state = healthFor(health, protocol, id);
    if (isBlockedByHealth(state, now)) {
      struck.set(id, "unhealthy");
      continue;
    }
    passed.push(id);
  }
  let sortedPassed = [...passed];
  if (!(customCascade || paidOpenRouterRequest)) {
    sortedPassed = sortedPassed.sort((left, right) => {
      if (exact && left === exact) return -1;
      if (exact && right === exact) return 1;
      return score(protocol, right, ordered, health) - score(protocol, left, ordered, health);
    });
  }
  const eligibleIds = sortedPassed.slice(0, config.maxAttempts);
  const eligibleSet = new Set(eligibleIds);
  for (const id of sortedPassed.slice(config.maxAttempts)) {
    if (!struck.has(id)) struck.set(id, "over-attempt-budget");
  }
  const providerOf = (id: string): ProviderId => catalog.find((entry) => entry.id === id)?.providerId ?? "agentrouter";
  const result: SimulatedCandidate[] = [];
  eligibleIds.forEach((id) => {
    result.push({ id, providerId: providerOf(id), eligible: true, rank: result.length + 1 });
  });
  for (const id of preDedup) {
    if (eligibleSet.has(id)) continue;
    const reason = struck.get(id);
    if (!reason) continue;
    result.push({ id, providerId: providerOf(id), eligible: false, strikeReason: reason, rank: result.length + 1 });
  }
  return result;
}
