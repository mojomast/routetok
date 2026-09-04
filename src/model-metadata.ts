import type { CatalogModel, ModelHealth, Protocol, ProviderId, RouterConfig } from "./types.js";

type RouteKind = "physical" | "virtual" | "custom_cascade";
export interface ModelMetadataInput {
  id: string;
  routeKind: RouteKind;
  model?: CatalogModel;
  config: RouterConfig;
  providerConfigured: Partial<Record<ProviderId, boolean>>;
  health: ModelHealth[];
  cascadeMembers?: string[];
  protocols?: Protocol[];
  free: boolean | null;
}

function rank(order: string[], id: string): number | null {
  const index = order.indexOf(id);
  return index === -1 ? null : index + 1;
}

function decimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const [coefficient = "0", exponentText = "0"] = raw.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  const expanded = point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}

function safeHealth(health: ModelHealth[], protocol: "openai" | "anthropic", id: string): object | null {
  const state = health.find((entry) => entry.protocol === protocol && entry.model === id);
  if (!state) return null;
  return {
    successes: state.successes,
    failures: state.failures,
    consecutive_failures: state.consecutiveFailures,
    latency_ewma_ms: state.latencyEwmaMs,
    in_flight: state.inflight,
    circuit_state: state.circuitState,
    circuit_open_until: state.circuitOpenUntil,
    rate_limit_until: state.rateLimitedUntil,
    entitlement_blocked: state.entitlementBlocked
  };
}

/**
 * Builds the explicit RouteTok model extension from bounded local facts only.
 * Catalog pricing rates are normalized internally per million units; this public
 * projection renders those rates as plain decimal strings without changing scale.
 */
export function serializeModelMetadata(input: ModelMetadataInput): object {
  const model = input.model;
  const physical = input.routeKind === "physical" && model !== undefined;
  const provider = physical ? model.providerId ?? "agentrouter" : "routetok";
  const configured = physical ? input.providerConfigured[provider as ProviderId] ?? false : true;
  const disabled = physical ? input.config.disabledModels.includes(input.id) : false;
  const enabled = physical
    ? configured && !disabled && (provider === "agentrouter" || input.free === true || input.config.enabledExternalModels.includes(input.id))
    : true;
  const pricing = physical ? model.pricing : undefined;
  const tiers = physical ? model.pricingTiers : undefined;

  return {
    schema_version: 1,
    route_kind: input.routeKind,
    display_name: physical ? model.displayName ?? model.id : input.id,
    provider,
    upstream_id: physical ? model.upstreamId ?? null : null,
    source: physical ? model.source : "synthetic",
    metadata_source: physical ? model.metadataSource ?? null : "routetok",
    protocols: physical ? model.protocols : input.protocols ?? ["openai", "anthropic"],
    endpoints: physical ? model.endpoints ?? null : null,
    context_window_tokens: physical ? model.contextTokens ?? null : null,
    max_output_tokens: physical ? model.maxOutputTokens ?? null : null,
    modalities: {
      input: physical ? model.inputModalities ?? null : null,
      output: physical ? model.outputModalities ?? null : null
    },
    capabilities: {
      tools: physical ? model.capabilities?.tools ?? null : null,
      vision: physical ? model.capabilities?.vision ?? null : null,
      audio: physical ? model.capabilities?.audio ?? null : null,
      reasoning: physical ? model.capabilities?.reasoning ?? null : null,
      caching: physical ? model.capabilities?.caching ?? null : null,
      web_search: physical ? model.capabilities?.webSearch ?? null : null
    },
    supported_parameters: physical ? model.supportedParameters ?? null : null,
    pricing: {
      currency: pricing?.currency ?? null,
      billing_unit: pricing?.unit ?? null,
      source: pricing?.source ?? null,
      input: decimal(pricing?.input),
      output: decimal(pricing?.output),
      cache_read: decimal(pricing?.cacheRead),
      cache_write: decimal(pricing?.cacheWrite),
      tiers: tiers === undefined || tiers === null ? null : tiers.map((tier) => ({
        prompt_tokens_threshold: tier.promptTokensThreshold ?? null,
        input: decimal(tier.input),
        output: decimal(tier.output),
        cache_read: decimal(tier.cacheRead),
        cache_write: decimal(tier.cacheWrite)
      }))
    },
    quality: {
      model_ratio: physical ? model.modelRatio : null,
      completion_ratio: physical ? model.completionRatio : null
    },
    free: input.free,
    access: { configured, enabled, disabled },
    routing: {
      openai_rank: rank(input.config.openaiOrder, input.id),
      anthropic_rank: rank(input.config.anthropicOrder, input.id),
      free_rank: rank(input.config.freeModelOrder, input.id),
      paid_openrouter_rank: rank(input.config.paidOpenRouterFallbackOrder, input.id),
      cascade_members: input.routeKind === "custom_cascade" ? input.cascadeMembers ?? [] : []
    },
    health: {
      openai: physical ? safeHealth(input.health, "openai", input.id) : null,
      anthropic: physical ? safeHealth(input.health, "anthropic", input.id) : null
    }
  };
}
