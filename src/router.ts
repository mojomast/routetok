import type { CatalogModel, ModelHealth, Protocol, RouterConfig } from "./types.js";
import { isFreeExternalCatalogModel, isTextGenerationModel } from "./catalog.js";

const VIRTUAL_MODELS = new Set(["auto", "best", "agentrouter-auto", "agentrouter-best", "free", "free-auto"]);

function freeModelScore(model: CatalogModel): number {
  return (model.capabilities?.reasoning ? 1_000_000_000 : 0) +
    (model.capabilities?.tools ? 500_000_000 : 0) +
    (model.contextTokens ?? 0) +
    (model.maxOutputTokens ?? 0) * 2;
}

function key(protocol: Protocol, model: string): string {
  return `${protocol}:${model}`;
}

function freshHealth(protocol: Protocol, model: string): ModelHealth {
  return {
    model,
    protocol,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    latencyEwmaMs: null,
    inflight: 0,
    circuitState: "closed",
    circuitOpenUntil: null,
    rateLimitedUntil: null,
    entitlementBlocked: false,
    recentOutcomes: []
  };
}

export class HealthRouter {
  private readonly health = new Map<string, ModelHealth>();

  candidates(
    protocol: Protocol,
    requestedModel: string,
    catalog: CatalogModel[],
    config: RouterConfig
  ): string[] {
    const now = Date.now();
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
    const freeModels = catalog
      .filter((model) => model.protocols.includes(protocol))
      .filter((model) => model.providerId && model.providerId !== "agentrouter")
      .filter((model) => isFreeExternalCatalogModel(model) && isTextGenerationModel(model))
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

    const virtual = Boolean(customCascade) || VIRTUAL_MODELS.has(requestedModel);
    let candidates = virtual
      ? ordered
      : [
          requestedModel,
          ...(config.fallbackExplicitModels ? ordered.filter((model) => model !== requestedModel) : [])
        ];

    candidates = candidates.filter((model, index) => candidates.indexOf(model) === index);
    const exact = virtual ? null : requestedModel;

    const filtered = candidates
      .filter((model) => {
        if (config.disabledModels.includes(model)) return false;
        if (!available.has(model)) return false;
        const state = this.peek(protocol, model);
        if (state.entitlementBlocked) return false;
        if (state.rateLimitedUntil && state.rateLimitedUntil > now) return false;
        if (state.circuitState === "open") {
          if (state.circuitOpenUntil && state.circuitOpenUntil <= now) {
            state.circuitState = "half-open";
            return true;
          }
          return false;
        }
        return true;
      });
    return (customCascade ? filtered : filtered.sort((left, right) => {
        if (exact && left === exact) return -1;
        if (exact && right === exact) return 1;
        return this.score(protocol, right, ordered) - this.score(protocol, left, ordered);
      }))
      .slice(0, config.maxAttempts);
  }

  recordSuccess(protocol: Protocol, model: string, latencyMs: number, config: RouterConfig): void {
    const state = this.get(protocol, model);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.circuitState = "closed";
    state.circuitOpenUntil = null;
    state.rateLimitedUntil = null;
    state.recentOutcomes.push(true);
    state.recentOutcomes = state.recentOutcomes.slice(-config.circuitWindowSize);
    state.latencyEwmaMs = state.latencyEwmaMs === null
      ? latencyMs
      : state.latencyEwmaMs * 0.8 + latencyMs * 0.2;
  }

  startAttempt(protocol: Protocol, model: string): void {
    this.get(protocol, model).inflight += 1;
  }

  finishAttempt(protocol: Protocol, model: string): void {
    const state = this.get(protocol, model);
    state.inflight = Math.max(0, state.inflight - 1);
  }

  recordTransientFailure(protocol: Protocol, model: string, config: RouterConfig): void {
    const state = this.get(protocol, model);
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.recentOutcomes.push(false);
    state.recentOutcomes = state.recentOutcomes.slice(-config.circuitWindowSize);

    const failureRate = state.recentOutcomes.length
      ? state.recentOutcomes.filter((outcome) => !outcome).length / state.recentOutcomes.length
      : 0;
    const shouldOpen =
      state.consecutiveFailures >= config.circuitFailureThreshold ||
      (state.recentOutcomes.length >= config.circuitMinimumSamples && failureRate >= 0.5);

    if (shouldOpen) {
      state.circuitState = "open";
      state.circuitOpenUntil = Date.now() + config.circuitOpenMs;
    }
  }

  recordPermanentFailure(protocol: Protocol, model: string): void {
    this.get(protocol, model).failures += 1;
  }

  recordRateLimit(protocol: Protocol, model: string, retryAfterMs: number): void {
    const state = this.get(protocol, model);
    state.failures += 1;
    state.rateLimitedUntil = Date.now() + retryAfterMs;
  }

  recordEntitlementFailure(protocol: Protocol, model: string): void {
    const state = this.get(protocol, model);
    state.failures += 1;
    state.entitlementBlocked = true;
  }

  reset(): void {
    this.health.clear();
  }

  snapshot(): ModelHealth[] {
    return [...this.health.values()]
      .map((state) => structuredClone(state))
      .sort((left, right) => key(left.protocol, left.model).localeCompare(key(right.protocol, right.model)));
  }

  private get(protocol: Protocol, model: string): ModelHealth {
    const stateKey = key(protocol, model);
    let state = this.health.get(stateKey);
    if (!state) {
      state = freshHealth(protocol, model);
      this.health.set(stateKey, state);
    }
    return state;
  }

  private peek(protocol: Protocol, model: string): ModelHealth {
    return this.health.get(key(protocol, model)) ?? freshHealth(protocol, model);
  }

  private score(protocol: Protocol, model: string, order: string[]): number {
    const state = this.peek(protocol, model);
    const orderIndex = order.indexOf(model);
    const base = orderIndex === -1 ? 0 : 1_000 - orderIndex * 100;
    const attempts = state.successes + state.failures;
    const successRate = attempts ? state.successes / attempts : 1;
    const latencyPenalty = state.latencyEwmaMs === null ? 0 : Math.min(50, state.latencyEwmaMs / 1_000);
    return base + successRate * 30 - state.consecutiveFailures * 80 - state.inflight * 140 - latencyPenalty;
  }
}
