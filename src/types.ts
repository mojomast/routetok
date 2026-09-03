export type Protocol = "openai" | "anthropic";
export type ProviderId = "agentrouter" | "openrouter" | "requesty" | "opencode" | "kimi" | "groq" | "together" | "fireworks" | "deepinfra" | "cerebras" | "mistral" | "generic";
export type EndpointKind = "chat" | "responses" | "messages";

export interface ProviderRuntime {
  id: ProviderId;
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  managementKey?: string;
  managementBaseUrl?: string;
  auth?: "bearer" | "none";
  endpoints?: EndpointKind[];
}

export interface ModelCapabilities {
  tools: boolean | null;
  vision: boolean | null;
  audio: boolean | null;
  reasoning: boolean | null;
  caching: boolean | null;
  webSearch: boolean | null;
}

export interface ModelPricing {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface CatalogModel {
  id: string;
  providerId?: ProviderId;
  upstreamId?: string;
  displayName?: string;
  contextTokens?: number | null;
  maxOutputTokens?: number | null;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: ModelCapabilities;
  pricing?: ModelPricing;
  endpoints?: EndpointKind[];
  supportedParameters?: string[];
  protocols: Protocol[];
  source: "live" | "fallback";
  modelRatio: number;
  completionRatio: number;
}

export interface RouterConfig {
  maxAttempts: number;
  fallbackExplicitModels: boolean;
  thinkingFallbackMode: "pin" | "strip";
  requestTimeoutMs: number;
  firstEventTimeoutMs: number;
  slowModelFirstEventTimeoutMs: number;
  streamIdleTimeoutMs: number;
  catalogRefreshHours: number;
  circuitFailureThreshold: number;
  circuitMinimumSamples: number;
  circuitWindowSize: number;
  circuitOpenMs: number;
  openaiOrder: string[];
  anthropicOrder: string[];
  paidOpenRouterFallbackOrder: string[];
  disabledModels: string[];
  enabledExternalModels: string[];
  freeModelOrder: string[];
  dashboardModel: string;
  customCascades: Array<{ name: string; members: string[] }>;
}

export interface RoutingRequirements {
  tools: boolean;
  inputModalities: string[];
  outputModalities: string[];
}

export interface ModelHealth {
  model: string;
  protocol: Protocol;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  latencyEwmaMs: number | null;
  inflight: number;
  circuitState: "closed" | "open" | "half-open";
  circuitOpenUntil: number | null;
  rateLimitedUntil: number | null;
  entitlementBlocked: boolean;
  recentOutcomes: boolean[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costCny: number;
  estimatedCostUsd: number;
  reportedCostUsd?: number;
  costUsd?: number;
}

export interface AttemptRecord {
  model: string;
  status: number | null;
  durationMs: number;
  firstOutputMs: number | null;
  outcome: "success" | "transient_error" | "permanent_error" | "rate_limited" | "cancelled";
  error?: string;
  providerId?: ProviderId;
}

export interface RequestRecord {
  id: string;
  timestamp: string;
  protocol: Protocol;
  path: string;
  requestedModel: string;
  selectedModel: string | null;
  stream: boolean;
  status: number;
  durationMs: number;
  ttftMs: number | null;
  generationDurationMs: number | null;
  outputTokensPerSecond: number | null;
  attempts: AttemptRecord[];
  usage: TokenUsage;
  error: string | null;
  provider?: ProviderId | null;
  trafficClass?: "client" | "sandbox";
}

export interface ProviderCredits {
  providerId: ProviderId;
  supported: boolean;
  fetchedAt: string | null;
  error: string | null;
  balanceUsd: number | null;
  usageUsd: number | null;
  limitUsd: number | null;
  remainingUsd: number | null;
}
