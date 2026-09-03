import type { CatalogModel, ModelCapabilities, ModelPricing, Protocol, ProviderId, ProviderRuntime } from "./types.js";

const CATALOG_FAILURE_RETRY_MS = 30_000;

const FALLBACK_MODELS: CatalogModel[] = [
  { id: "gpt-5.6-sol", protocols: ["openai"], source: "fallback", modelRatio: 1.5, completionRatio: 5 },
  { id: "claude-opus-5", protocols: ["anthropic", "openai"], source: "fallback", modelRatio: 4, completionRatio: 5 },
  { id: "claude-opus-4-8", protocols: ["anthropic", "openai"], source: "fallback", modelRatio: 4, completionRatio: 5 },
  { id: "glm-5.3", protocols: ["anthropic", "openai"], source: "fallback", modelRatio: 1.5, completionRatio: 4 },
  { id: "deepseek-v4-flash", protocols: ["anthropic", "openai"], source: "fallback", modelRatio: 1, completionRatio: 3 }
];

for (const model of FALLBACK_MODELS) {
  model.providerId = "agentrouter";
  model.upstreamId = model.id;
  model.displayName = model.id;
  model.contextTokens = null;
  model.maxOutputTokens = null;
  model.inputModalities = [];
  model.outputModalities = [];
  model.capabilities = { tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null };
  model.pricing = { input: null, output: null, cacheRead: null, cacheWrite: null };
}

interface PricingResponse {
  success?: boolean;
  data?: Array<{
    model_name?: unknown;
    supported_endpoint_types?: unknown;
    model_ratio?: unknown;
    completion_ratio?: unknown;
  }>;
}

interface ProviderCatalogState {
  providerId: ProviderId;
  configured: boolean;
  models: CatalogModel[];
  lastRefresh: number | null;
  lastAttempt: number | null;
  lastError: string | null;
}

const nullableCapabilities = (): ModelCapabilities => ({
  tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null
});
const nullablePricing = (): ModelPricing => ({ input: null, output: null, cacheRead: null, cacheWrite: null });
const finite = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const million = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed === null ? null : parsed * 1_000_000;
};
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

const ZEN_FREE_MODELS: Array<{ id: string; context: number; output: number; modalities: string[]; endpoints: NonNullable<CatalogModel["endpoints"]> }> = [
  { id: "big-pickle", context: 200_000, output: 32_000, modalities: ["text"], endpoints: ["chat"] },
  { id: "mimo-v2.5-free", context: 200_000, output: 32_000, modalities: ["text", "image", "audio", "video"], endpoints: ["chat"] },
  { id: "ling-3.0-flash-fin-free", context: 262_144, output: 32_768, modalities: ["text"], endpoints: ["chat"] },
  { id: "nemotron-3-ultra-free", context: 1_000_000, output: 128_000, modalities: ["text"], endpoints: ["chat"] },
  { id: "nemotron-3.5-lightning-free", context: 262_144, output: 262_144, modalities: ["text"], endpoints: ["chat"] },
  { id: "muse-spark-1.2-contributor-free", context: 1_048_576, output: 131_072, modalities: ["text", "image", "video", "pdf", "audio"], endpoints: ["responses"] }
];

function zenFreeCatalog(payload: unknown): CatalogModel[] {
  const raw = Array.isArray(payload) ? payload : object(payload).data;
  const available = new Set(Array.isArray(raw) ? raw.map((item) => object(item).id).filter((id): id is string => typeof id === "string") : []);
  return ZEN_FREE_MODELS.filter((model) => available.has(model.id)).map((model) => ({
    id: `opencode:${model.id}`,
    providerId: "opencode",
    upstreamId: model.id,
    displayName: `OpenCode Zen: ${model.id}`,
    protocols: ["openai"],
    endpoints: model.endpoints,
    source: "live",
    modelRatio: 0,
    completionRatio: 0,
    contextTokens: model.context,
    maxOutputTokens: model.output,
    inputModalities: model.modalities,
    outputModalities: ["text"],
    capabilities: { tools: true, vision: model.modalities.includes("image"), audio: model.modalities.includes("audio"), reasoning: true, caching: true, webSearch: false },
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: null }
  }));
}

function kimiCodingCatalog(): CatalogModel[] {
  return [
    { id: "k3", context: 1_048_576, output: 131_072 },
    { id: "k3-256k", context: 262_144, output: 131_072 },
    { id: "kimi-for-coding", context: 262_144, output: 32_768 },
    { id: "kimi-for-coding-highspeed", context: 262_144, output: 32_768 }
  ].map((model) => ({
    id: `kimi:${model.id}`,
    providerId: "kimi" as const,
    upstreamId: model.id,
    displayName: `Kimi Coding: ${model.id}`,
    protocols: ["openai", "anthropic"] as Protocol[],
    endpoints: ["chat", "responses", "messages"],
    source: "live" as const,
    modelRatio: 1,
    completionRatio: 1,
    contextTokens: model.context,
    maxOutputTokens: model.output,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    capabilities: { tools: true, vision: true, audio: false, reasoning: true, caching: true, webSearch: false },
    pricing: nullablePricing()
  }));
}

export function parseOpenRouterCatalog(payload: unknown): CatalogModel[] {
  const data = object(payload).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap<CatalogModel>((item) => {
    const entry = object(item);
    if (typeof entry.id !== "string" || !entry.id) return [];
    const architecture = object(entry.architecture);
    const topProvider = object(entry.top_provider);
    const parameters = strings(entry.supported_parameters);
    const inputModalities = strings(architecture.input_modalities);
    const outputModalities = strings(architecture.output_modalities);
    const pricing = object(entry.pricing);
    return [{
      id: `openrouter:${entry.id}`,
      providerId: "openrouter",
      upstreamId: entry.id,
      displayName: typeof entry.name === "string" ? entry.name : entry.id,
      protocols: ["openai", "anthropic"], source: "live", modelRatio: 1, completionRatio: 1,
      contextTokens: finite(entry.context_length),
      maxOutputTokens: finite(topProvider.max_completion_tokens),
      inputModalities, outputModalities,
      ...(Array.isArray(entry.supported_parameters) ? { supportedParameters: parameters } : {}),
      capabilities: {
        tools: parameters.length ? parameters.some((p) => p === "tools" || p === "tool_choice") : null,
        vision: inputModalities.length ? inputModalities.includes("image") : null,
        audio: inputModalities.includes("audio") || outputModalities.includes("audio")
          ? true
          : inputModalities.length && outputModalities.length ? false : null,
        reasoning: parameters.some((p) => p.includes("reasoning")),
        caching: pricing.input_cache_read !== undefined || pricing.input_cache_write !== undefined,
        webSearch: parameters.some((p) => p.includes("web"))
      },
      pricing: {
        input: million(pricing.prompt), output: million(pricing.completion),
        cacheRead: million(pricing.input_cache_read ?? pricing.cache_read),
        cacheWrite: million(pricing.input_cache_write ?? pricing.cache_write)
      }
    }];
  });
}

export function isTextGenerationModel(model: CatalogModel, protocol: Protocol = "openai"): boolean {
  const textEndpoints = protocol === "anthropic" ? ["messages"] : ["chat", "responses"];
  if (!model.protocols.includes(protocol) || (model.endpoints && !model.endpoints.some((endpoint) => textEndpoints.includes(endpoint)))) return false;
  if (model.inputModalities?.length && !model.inputModalities.includes("text")) return false;
  if (model.outputModalities?.length && (model.outputModalities.length !== 1 || model.outputModalities[0] !== "text")) return false;
  if (model.providerId === "openrouter" && model.supportedParameters?.length) {
    return model.supportedParameters.some((parameter) => ["max_tokens", "temperature", "top_p", "tools", "reasoning"].includes(parameter));
  }
  return true;
}

export function isFreeExternalCatalogModel(model: CatalogModel): boolean {
  if (!model.providerId || model.providerId === "agentrouter") return false;
  if (model.pricing?.input !== 0 || model.pricing?.output !== 0) return false;
  if (model.providerId !== "openrouter") return true;
  return model.upstreamId === "openrouter/free" || model.upstreamId?.endsWith(":free") === true;
}

export function parseRequestyCatalog(payload: unknown): CatalogModel[] {
  const raw = Array.isArray(payload) ? payload : object(payload).data;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap<CatalogModel>((item) => {
    const entry = object(item);
    const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : null;
    if (!id) return [];
    const type = typeof entry.api === "string" ? entry.api.toLowerCase()
      : typeof entry.type === "string" ? entry.type.toLowerCase() : "chat";
    if (type && !type.includes("chat") && !type.includes("language") && type !== "model") return [];
    const modalities = object(entry.modalities);
    let inputModalities = strings(entry.input_modalities).length
      ? strings(entry.input_modalities) : strings(modalities.input);
    let outputModalities = strings(entry.output_modalities).length
      ? strings(entry.output_modalities) : strings(modalities.output);
    if (inputModalities.length === 0 && entry.supports_vision === true) inputModalities = ["text", "image"];
    const features = strings(entry.supported_parameters).concat(strings(entry.capabilities));
    const pricingBands = Array.isArray(entry.pricing)
      ? entry.pricing.map(object).sort((left, right) => (finite(left.prompt_tokens_threshold) ?? 0) - (finite(right.prompt_tokens_threshold) ?? 0))
      : [];
    const prices = pricingBands[0] ?? object(entry.pricing);
    const capabilities = nullableCapabilities();
    capabilities.tools = typeof entry.supports_tool_calling === "boolean"
      ? entry.supports_tool_calling : features.length ? features.some((p) => /tool|function/.test(p)) : null;
    capabilities.vision = typeof entry.supports_vision === "boolean"
      ? entry.supports_vision : inputModalities.length ? inputModalities.includes("image") : null;
    capabilities.audio = inputModalities.includes("audio") || outputModalities.includes("audio")
      ? true
      : inputModalities.length && outputModalities.length ? false : null;
    capabilities.reasoning = typeof entry.supports_reasoning === "boolean" ? entry.supports_reasoning : features.some((p) => /reason/.test(p));
    capabilities.caching = typeof entry.supports_caching === "boolean" ? entry.supports_caching
      : prices.cache_read !== undefined || prices.cache_write !== undefined || entry.cached_price !== undefined;
    capabilities.webSearch = typeof entry.supports_web_search === "boolean" ? entry.supports_web_search : features.some((p) => /web|search/.test(p));
    return [{
      id: `requesty:${id}`, providerId: "requesty", upstreamId: id,
      displayName: typeof entry.name === "string" ? entry.name : id,
      protocols: ["openai", "anthropic"], source: "live", modelRatio: 1, completionRatio: 1,
      contextTokens: finite(entry.context_window ?? entry.context_length),
      maxOutputTokens: finite(entry.max_output_tokens ?? entry.max_completion_tokens),
      inputModalities, outputModalities, capabilities,
      pricing: {
        input: million(entry.input_price ?? prices.input_price ?? prices.prompt ?? prices.input),
        output: million(entry.output_price ?? prices.output_price ?? prices.completion ?? prices.output),
        cacheRead: million(entry.cached_price ?? prices.cached_price ?? prices.cache_read ?? prices.input_cache_read),
        cacheWrite: million(entry.cache_write_price ?? prices.caching_price ?? prices.caching_5m_price ?? prices.cache_write ?? prices.input_cache_write)
      }
    }];
  });
}

export function parseOpenAiCompatibleCatalog(payload: unknown, provider: ProviderRuntime): CatalogModel[] {
  const root = object(payload);
  const raw = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  return raw.slice(0, 10_000).flatMap<CatalogModel>((item) => {
    const entry = object(item);
    const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : null;
    if (!id || id.length > 512 || /[\0-\x1f\x7f]/.test(id)) return [];
    if (provider.id === "groq" && (entry.active === false || /whisper|tts|playai/i.test(id))) return [];
    if (provider.id === "together" && typeof entry.type === "string" && !["chat", "language", "code"].includes(entry.type.toLowerCase())) return [];
    if (provider.id === "mistral") {
      const capabilities = object(entry.capabilities);
      if (entry.archived === true || capabilities.completion_chat === false) return [];
    }
    if (provider.id === "deepinfra") {
      const metadata = object(entry.metadata);
      const tags = strings(metadata.tags ?? entry.tags);
      if (tags.length && !tags.some((tag) => /chat|text-generation/i.test(tag))) return [];
    }
    const architecture = object(entry.architecture);
    const capabilities = object(entry.capabilities);
    const pricing = object(entry.pricing);
    const inputModalities = strings(architecture.input_modalities ?? entry.input_modalities);
    const outputModalities = strings(architecture.output_modalities ?? entry.output_modalities);
    const directPricing = provider.id === "together" || provider.id === "deepinfra";
    const price = (value: unknown): number | null => directPricing ? finite(value) : million(value);
    return [{
      id: `${provider.id}:${id}`, providerId: provider.id, upstreamId: id,
      displayName: typeof entry.display_name === "string" ? entry.display_name : typeof entry.name === "string" ? entry.name : id,
      protocols: ["openai"], endpoints: provider.endpoints ?? ["chat"], source: "live", modelRatio: 1, completionRatio: 1,
      contextTokens: finite(entry.context_window ?? entry.context_length ?? entry.max_context_length),
      maxOutputTokens: finite(entry.max_completion_tokens ?? entry.max_output_tokens ?? entry.max_tokens),
      inputModalities, outputModalities,
      supportedParameters: strings(entry.supported_parameters),
      capabilities: {
        tools: typeof capabilities.function_calling === "boolean" ? capabilities.function_calling : null,
        vision: typeof capabilities.vision === "boolean" ? capabilities.vision : inputModalities.includes("image") || null,
        audio: inputModalities.includes("audio") || outputModalities.includes("audio") || null,
        reasoning: typeof capabilities.reasoning === "boolean" ? capabilities.reasoning : null,
        caching: null, webSearch: null
      },
      pricing: { input: price(pricing.input ?? pricing.prompt), output: price(pricing.output ?? pricing.completion), cacheRead: null, cacheWrite: null }
    }];
  });
}

export class CatalogService {
  private models: CatalogModel[] = [];
  private readonly providers: ProviderRuntime[];
  private readonly states = new Map<ProviderId, ProviderCatalogState>();
  private refreshPromise: Promise<CatalogModel[]> | null = null;
  private refreshingProviders = new Set<ProviderId>();

  constructor(input: string | ProviderRuntime[], private readonly fetchImpl: typeof fetch = fetch) {
    this.providers = typeof input === "string" ? [{ id: "agentrouter", configured: true, baseUrl: input, apiKey: "" }] : input;
    for (const provider of this.providers) {
      this.states.set(provider.id, {
        providerId: provider.id, configured: provider.configured,
        models: provider.id === "agentrouter" && provider.configured ? structuredClone(FALLBACK_MODELS) : [],
        lastRefresh: null, lastAttempt: null, lastError: null
      });
    }
    this.rebuild();
  }

  getModels(protocol?: Protocol): CatalogModel[] {
    const models = protocol
      ? this.models.filter((model) => model.protocols.includes(protocol))
      : this.models;
    return structuredClone(models);
  }

  has(model: string, protocol: Protocol): boolean {
    return this.models.some((entry) => entry.id === model && entry.protocols.includes(protocol));
  }

  resolve(model: string, protocol?: Protocol): CatalogModel | undefined {
    const found = this.models.find((entry) => entry.id === model && (!protocol || entry.protocols.includes(protocol)));
    return found ? structuredClone(found) : undefined;
  }

  status(): {
    lastRefresh: string | null;
    lastAttempt: string | null;
    lastError: string | null;
    source: "live" | "fallback";
    providers: Array<{ providerId: ProviderId; configured: boolean; connected: boolean; lastRefresh: string | null; lastAttempt: string | null; lastError: string | null; source: "live" | "fallback" | "unavailable"; modelCount: number }>;
  } {
    const providerStates = [...this.states.values()];
    const attempts = providerStates.map((state) => state.lastAttempt).filter((value): value is number => value !== null);
    const refreshes = providerStates.map((state) => state.lastRefresh).filter((value): value is number => value !== null);
    const errors = providerStates.filter((state) => state.configured && state.lastError).map((state) => `${state.providerId}: ${state.lastError}`);
    return {
      lastRefresh: refreshes.length ? new Date(Math.max(...refreshes)).toISOString() : null,
      lastAttempt: attempts.length ? new Date(Math.max(...attempts)).toISOString() : null,
      lastError: errors.length ? errors.join("; ") : null,
      source: this.models.some((model) => model.source === "live") ? "live" : "fallback"
      ,providers: providerStates.map((state) => ({
        providerId: state.providerId, configured: state.configured,
        connected: state.lastRefresh !== null && state.lastError === null,
        lastRefresh: state.lastRefresh ? new Date(state.lastRefresh).toISOString() : null,
        lastAttempt: state.lastAttempt ? new Date(state.lastAttempt).toISOString() : null,
        lastError: state.lastError,
        source: state.models.some((model) => model.source === "live") ? "live" : state.models.length ? "fallback" : "unavailable",
        modelCount: state.models.length
      }))
    };
  }

  async refreshIfStale(hours: number): Promise<CatalogModel[]> {
    const configured = [...this.states.values()].filter((state) => state.configured);
    const now = Date.now();
    const stale = configured.filter((state) => state.lastError
      ? state.lastAttempt === null || now - state.lastAttempt >= CATALOG_FAILURE_RETRY_MS
      : state.lastRefresh === null || now - state.lastRefresh >= hours * 3_600_000);
    return stale.length ? this.refreshProviders(stale.map((state) => state.providerId)) : this.getModels();
  }

  async refresh(providerId?: ProviderId): Promise<CatalogModel[]> {
    if (providerId) {
      const provider = this.providers.find((item) => item.id === providerId);
      if (!provider) throw new Error(`Unknown provider: ${providerId}`);
      await this.fetchProvider(provider);
      return this.getModels();
    }
    return this.refreshProviders(this.providers.filter((provider) => provider.configured).map((provider) => provider.id));
  }

  private refreshProviders(providerIds: ProviderId[]): Promise<CatalogModel[]> {
    if (this.refreshPromise) {
      const missing = providerIds.filter((providerId) => !this.refreshingProviders.has(providerId));
      return missing.length ? this.refreshPromise.then(() => this.refreshProviders(missing)) : this.refreshPromise;
    }
    const providers = this.providers.filter((provider) => provider.configured && providerIds.includes(provider.id));
    this.refreshingProviders = new Set(providers.map((provider) => provider.id));
    this.refreshPromise = Promise.all(providers.map((provider) => this.fetchProvider(provider)))
      .then(() => this.getModels()).finally(() => {
      this.refreshPromise = null;
      this.refreshingProviders.clear();
    });
    return this.refreshPromise;
  }

  async providerChanged(providerId: ProviderId): Promise<CatalogModel[]> {
    const provider = this.providers.find((entry) => entry.id === providerId);
    const state = this.states.get(providerId);
    if (!provider || !state) throw new Error(`Unknown provider: ${providerId}`);
    state.configured = provider.configured;
    state.lastAttempt = null;
    state.lastRefresh = null;
    state.lastError = null;
    if (!provider.configured) {
      state.models = [];
      this.rebuild();
      return this.getModels();
    }
    await this.fetchProvider(provider);
    return this.getModels();
  }

  private async fetchProvider(provider: ProviderRuntime): Promise<void> {
    const state = this.states.get(provider.id)!;
    if (!provider.configured) return;
    state.lastAttempt = Date.now();
    try {
      if (provider.id === "kimi") {
        state.models = kimiCodingCatalog();
        state.lastRefresh = Date.now();
        state.lastError = null;
        this.rebuild();
        return;
      }
      const endpoint = provider.id === "agentrouter" ? "/api/pricing" : provider.id === "openrouter" ? "/models?output_modalities=all" : "/models";
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "routetok/0.1" };
      if (provider.id !== "agentrouter" && provider.auth !== "none") headers.authorization = `Bearer ${provider.apiKey}`;
      const response = await this.fetchImpl(`${provider.baseUrl}${endpoint}`, {
        headers: {
          ...headers
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) throw new Error("catalog returned non-JSON content");

      const payload = await response.json() as unknown;
      const models = provider.id === "openrouter" ? parseOpenRouterCatalog(payload)
        : provider.id === "requesty" ? parseRequestyCatalog(payload)
        : provider.id === "opencode" ? zenFreeCatalog(payload)
        : ["groq", "together", "fireworks", "deepinfra", "cerebras", "mistral", "generic"].includes(provider.id) ? parseOpenAiCompatibleCatalog(payload, provider)
        : (((payload as PricingResponse).data ?? []).flatMap<CatalogModel>((entry) => {
        if (typeof entry.model_name !== "string" || !Array.isArray(entry.supported_endpoint_types)) {
          return [];
        }
        const protocols = entry.supported_endpoint_types.filter(
          (protocol): protocol is Protocol => protocol === "openai" || protocol === "anthropic"
        );
        if (protocols.length === 0) return [];
        return [{
          id: entry.model_name,
          providerId: "agentrouter",
          upstreamId: entry.model_name,
          displayName: entry.model_name,
          protocols: [...new Set(protocols)],
          source: "live",
          modelRatio: typeof entry.model_ratio === "number" ? entry.model_ratio : 1,
          completionRatio: typeof entry.completion_ratio === "number" ? entry.completion_ratio : 1,
          capabilities: nullableCapabilities(), pricing: nullablePricing()
        }];
      }));
      if (models.length === 0) throw new Error("catalog contained no usable models");

      state.models = models;
      state.lastRefresh = Date.now();
      state.lastError = null;
    } catch (error) {
      state.lastError = (error as Error).message;
      if (!state.lastRefresh && provider.id === "agentrouter") state.models = structuredClone(FALLBACK_MODELS);
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.models = [...this.states.values()].flatMap((state) => state.models);
  }
}
