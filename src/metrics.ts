import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelHealth, RequestRecord } from "./types.js";

interface AggregateTotals {
  requests: number;
  upstreamAttempts: number;
  clientCancellations: number;
  successes: number;
  failures: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCny: number;
  estimatedCostUsd: number;
  reportedCostUsd: number;
  costUsd: number;
  totalDurationMs: number;
  ttftSamples: number;
  totalTtftMs: number;
  generationSamples: number;
  totalGenerationDurationMs: number;
  generationOutputTokens: number;
}

export interface InFlightRequest {
  id: string;
  timestamp: string;
  protocol: "openai" | "anthropic";
  path: string;
  requestedModel: string;
  selectedModel: string | null;
  stream: boolean;
  phase: "routing" | "attempting" | "streaming";
  attemptCount: number;
  ttftMs: number | null;
  outputUtf8Bytes: number;
  firstTextAt: number | null;
}

export interface InFlightSnapshot extends Omit<InFlightRequest, "outputUtf8Bytes" | "firstTextAt"> {
  durationMs: number;
  estimatedOutputTokens: number;
  estimatedOutputTokensPerSecond: number | null;
}

interface ModelAggregate {
  attempts: number;
  successes: number;
  failures: number;
  cancellations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCny: number;
  estimatedCostUsd: number;
  reportedCostUsd: number;
  costUsd: number;
  totalLatencyMs: number;
  errors: Record<string, number>;
}

export interface MetricSample {
  timestamp: string;
  requestId: string;
  protocol: "openai" | "anthropic";
  model: string | null;
  provider: string | null;
  status: number;
  success: boolean;
  attempts: number;
  durationMs: number;
  ttftMs: number | null;
  outputTokensPerSecond: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  reportedCostUsd: number;
  costUsd: number;
}

interface PersistedMetrics {
  totals: AggregateTotals;
  experimentTotals: AggregateTotals;
  byModel: Record<string, ModelAggregate>;
  recent: RequestRecord[];
  series: MetricSample[];
}

function metricSample(record: RequestRecord): MetricSample {
  return {
    timestamp: record.timestamp,
    requestId: record.id,
    protocol: record.protocol,
    model: record.selectedModel,
    provider: record.provider ?? record.attempts.find((attempt) => attempt.model === record.selectedModel)?.providerId ?? null,
    status: record.status,
    success: record.status >= 200 && record.status < 300 && !record.error,
    attempts: record.attempts.length,
    durationMs: record.durationMs,
    ttftMs: record.ttftMs,
    outputTokensPerSecond: record.outputTokensPerSecond,
    inputTokens: record.usage.input,
    outputTokens: record.usage.output,
    cacheReadTokens: record.usage.cacheRead,
    cacheWriteTokens: record.usage.cacheWrite,
    estimatedCostUsd: record.usage.estimatedCostUsd,
    reportedCostUsd: record.usage.reportedCostUsd ?? 0,
    costUsd: record.usage.costUsd ?? record.usage.reportedCostUsd ?? record.usage.estimatedCostUsd
  };
}

function emptyMetrics(): PersistedMetrics {
  const totals = (): AggregateTotals => ({
    requests: 0, upstreamAttempts: 0, clientCancellations: 0, successes: 0, failures: 0, fallbacks: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0,
    estimatedCostUsd: 0, reportedCostUsd: 0, costUsd: 0, totalDurationMs: 0, ttftSamples: 0,
    totalTtftMs: 0, generationSamples: 0, totalGenerationDurationMs: 0, generationOutputTokens: 0
  });
  return {
    totals: totals(),
    experimentTotals: totals(),
    byModel: {},
    recent: [],
    series: []
  };
}

function emptyModel(): ModelAggregate {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    cancellations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCny: 0,
    estimatedCostUsd: 0,
    reportedCostUsd: 0,
    costUsd: 0,
    totalLatencyMs: 0,
    errors: {}
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nullableNonNegative(value: unknown): number | null {
  return value === null || value === undefined ? null : nonNegative(value, 0);
}

function normalizeTotals(input: unknown): AggregateTotals {
  const value = object(input);
  if (!value) throw new Error("metrics totals must be an object");
  const output = emptyMetrics().totals;
  for (const key of Object.keys(output) as Array<keyof AggregateTotals>) output[key] = nonNegative(value[key]);
  output.costUsd = nonNegative(value.costUsd, output.reportedCostUsd + output.estimatedCostUsd);
  return output;
}

function normalizeModel(input: unknown): ModelAggregate | null {
  const value = object(input);
  if (!value) return null;
  const output = emptyModel();
  for (const key of Object.keys(output) as Array<keyof ModelAggregate>) {
    if (key !== "errors") (output[key] as number) = nonNegative(value[key]);
  }
  output.costUsd = nonNegative(value.costUsd, output.reportedCostUsd + output.estimatedCostUsd);
  const errors = object(value.errors);
  output.errors = errors ? Object.fromEntries(Object.entries(errors)
    .filter(([key, count]) => key.length <= 1_000 && nonNegative(count, -1) >= 0)
    .map(([key, count]) => [key, nonNegative(count)])) : {};
  return output;
}

function normalizeRecord(input: unknown): RequestRecord | null {
  const value = object(input);
  const usage = object(value?.usage);
  if (!value || !usage || !Array.isArray(value.attempts) || typeof value.id !== "string" || typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) || (value.protocol !== "openai" && value.protocol !== "anthropic") ||
    typeof value.path !== "string" || typeof value.requestedModel !== "string" ||
    (value.selectedModel !== null && typeof value.selectedModel !== "string") || typeof value.stream !== "boolean") return null;
  const attempts = value.attempts.flatMap((inputAttempt) => {
    const attempt = object(inputAttempt);
    if (!attempt || typeof attempt.model !== "string" || !["success", "transient_error", "permanent_error", "rate_limited", "cancelled", "committed_failure"].includes(String(attempt.outcome))) return [];
    return [{
      ...attempt,
      status: attempt.status === null ? null : nonNegative(attempt.status),
      durationMs: nonNegative(attempt.durationMs),
      firstOutputMs: nullableNonNegative(attempt.firstOutputMs)
    }];
  });
  if (attempts.length !== value.attempts.length) return null;
  return {
    ...value,
    status: nonNegative(value.status),
    durationMs: nonNegative(value.durationMs),
    ttftMs: nullableNonNegative(value.ttftMs),
    generationDurationMs: nullableNonNegative(value.generationDurationMs),
    outputTokensPerSecond: nullableNonNegative(value.outputTokensPerSecond),
    attempts,
    usage: {
      input: nonNegative(usage.input), output: nonNegative(usage.output),
      cacheRead: nonNegative(usage.cacheRead), cacheWrite: nonNegative(usage.cacheWrite),
      costCny: nonNegative(usage.costCny), estimatedCostUsd: nonNegative(usage.estimatedCostUsd),
      reportedCostUsd: nonNegative(usage.reportedCostUsd),
      costUsd: nonNegative(usage.costUsd, nonNegative(usage.reportedCostUsd) || nonNegative(usage.estimatedCostUsd))
    },
    error: typeof value.error === "string" ? value.error : null
  } as RequestRecord;
}

function normalizeSample(input: unknown): MetricSample | null {
  const value = object(input);
  if (!value || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) || typeof value.requestId !== "string" ||
    (value.protocol !== "openai" && value.protocol !== "anthropic") || (value.model !== null && typeof value.model !== "string") ||
    (value.provider !== null && typeof value.provider !== "string") || typeof value.success !== "boolean") return null;
  return {
    timestamp: value.timestamp, requestId: value.requestId, protocol: value.protocol, model: value.model, provider: value.provider,
    status: nonNegative(value.status), success: value.success, attempts: nonNegative(value.attempts), durationMs: nonNegative(value.durationMs),
    ttftMs: nullableNonNegative(value.ttftMs), outputTokensPerSecond: nullableNonNegative(value.outputTokensPerSecond),
    inputTokens: nonNegative(value.inputTokens), outputTokens: nonNegative(value.outputTokens),
    cacheReadTokens: nonNegative(value.cacheReadTokens), cacheWriteTokens: nonNegative(value.cacheWriteTokens),
    estimatedCostUsd: nonNegative(value.estimatedCostUsd), reportedCostUsd: nonNegative(value.reportedCostUsd), costUsd: nonNegative(value.costUsd)
  };
}

function normalizeMetrics(input: unknown): PersistedMetrics {
  const value = object(input);
  const models = object(value?.byModel);
  if (!value || !models || !Array.isArray(value.recent)) throw new Error("metrics file schema is invalid");
  const normalizedModels = Object.fromEntries(Object.entries(models).slice(0, 10_000).flatMap(([key, model]) => {
    const normalized = normalizeModel(model);
    return normalized && key.length <= 1_000 ? [[key, normalized]] : [];
  }));
  const totals = normalizeTotals(value.totals);
  const rawTotals = object(value.totals);
  if (rawTotals?.upstreamAttempts === undefined) {
    totals.upstreamAttempts = Object.values(normalizedModels).reduce((sum, model) => sum + model.attempts, 0);
  }
  const recent = value.recent.slice(0, 100).map(normalizeRecord).filter((record): record is RequestRecord => record !== null);
  const series = Array.isArray(value.series)
    ? value.series.slice(-5_000).map(normalizeSample).filter((sample): sample is MetricSample => sample !== null)
    : recent.slice().reverse().map(metricSample);
  return {
    totals,
    experimentTotals: value.experimentTotals === undefined ? emptyMetrics().experimentTotals : normalizeTotals(value.experimentTotals),
    byModel: normalizedModels,
    recent,
    series
  };
}

function metricLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export class MetricsStore {
  private state = emptyMetrics();
  private readonly filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly recordWaiters = new Map<string, Set<(record: RequestRecord | null) => void>>();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "metrics.json");
  }

  async load(): Promise<void> {
    try {
      this.state = normalizeMetrics(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Ignoring invalid persisted metrics:", (error as Error).message);
      }
    }
  }

  record(record: RequestRecord): void {
    this.inFlight.delete(record.id);
    const totals = record.trafficClass === "sandbox" ? this.state.experimentTotals : this.state.totals;
    totals.requests += 1;
    totals.upstreamAttempts = (totals.upstreamAttempts ?? 0) + record.attempts.length;
    if (record.status === 499) totals.clientCancellations = (totals.clientCancellations ?? 0) + 1;
    totals.totalDurationMs += record.durationMs;
    totals.inputTokens += record.usage.input;
    totals.outputTokens += record.usage.output;
    totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + record.usage.cacheRead;
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + record.usage.cacheWrite;
    totals.costCny = (totals.costCny ?? 0) + record.usage.costCny;
    totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + record.usage.estimatedCostUsd;
    totals.reportedCostUsd += record.usage.reportedCostUsd ?? 0;
    totals.costUsd += record.usage.costUsd ?? record.usage.reportedCostUsd ?? record.usage.estimatedCostUsd;
    if (record.ttftMs !== null) {
      totals.ttftSamples += 1;
      totals.totalTtftMs += record.ttftMs;
    }
    if (record.generationDurationMs !== null && record.generationDurationMs > 0) {
      totals.generationSamples += 1;
      totals.totalGenerationDurationMs += record.generationDurationMs;
      totals.generationOutputTokens += record.usage.output;
    }
    if (record.status >= 200 && record.status < 300 && !record.error) totals.successes += 1;
    else totals.failures += 1;
    if (record.attempts.length > 1) totals.fallbacks += 1;

    if (record.trafficClass !== "sandbox") for (const attempt of record.attempts) {
      const aggregateKey = `${record.protocol}:${attempt.model}`;
      const model = (this.state.byModel[aggregateKey] ??= emptyModel());
      model.attempts += 1;
      model.totalLatencyMs += attempt.durationMs;
      if (attempt.outcome === "success") model.successes += 1;
      else if (attempt.outcome === "cancelled") model.cancellations = (model.cancellations ?? 0) + 1;
      else {
        model.failures += 1;
        const error = attempt.error ?? (attempt.status ? `HTTP ${attempt.status}` : "network_error");
        model.errors[error] = (model.errors[error] ?? 0) + 1;
      }
    }

    if (record.trafficClass !== "sandbox" && record.selectedModel) {
      const aggregateKey = `${record.protocol}:${record.selectedModel}`;
      const model = (this.state.byModel[aggregateKey] ??= emptyModel());
      model.inputTokens += record.usage.input;
      model.outputTokens += record.usage.output;
      model.cacheReadTokens = (model.cacheReadTokens ?? 0) + record.usage.cacheRead;
      model.cacheWriteTokens = (model.cacheWriteTokens ?? 0) + record.usage.cacheWrite;
      model.costCny = (model.costCny ?? 0) + record.usage.costCny;
      model.estimatedCostUsd = (model.estimatedCostUsd ?? 0) + record.usage.estimatedCostUsd;
      model.reportedCostUsd += record.usage.reportedCostUsd ?? 0;
      model.costUsd += record.usage.costUsd ?? record.usage.reportedCostUsd ?? record.usage.estimatedCostUsd;
    }

    this.state.recent.unshift(record);
    this.state.recent = this.state.recent.slice(0, 100);
    if (record.trafficClass !== "sandbox") {
      this.state.series.push(metricSample(record));
      this.state.series = this.state.series.slice(-5_000);
    }
    for (const resolve of this.recordWaiters.get(record.id) ?? []) resolve(structuredClone(record));
    this.recordWaiters.delete(record.id);
    this.scheduleSave();
  }

  waitForRecord(id: string, timeoutMs = 2_000): Promise<RequestRecord | null> {
    const existing = this.state.recent.find((record) => record.id === id);
    if (existing) return Promise.resolve(structuredClone(existing));
    return new Promise((resolve) => {
      const waiters = this.recordWaiters.get(id) ?? new Set();
      let timer: NodeJS.Timeout;
      const finish = (record: RequestRecord | null) => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (!waiters.size) this.recordWaiters.delete(id);
        resolve(record);
      };
      waiters.add(finish);
      this.recordWaiters.set(id, waiters);
      timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref();
    });
  }

  beginInFlight(request: InFlightRequest): void {
    this.inFlight.set(request.id, structuredClone(request));
  }

  updateInFlight(id: string, patch: Partial<InFlightRequest>): void {
    const current = this.inFlight.get(id);
    if (current) Object.assign(current, patch);
  }

  snapshot(health: ModelHealth[]): Omit<PersistedMetrics, "series"> & {
    health: ModelHealth[];
    inFlight: InFlightSnapshot[];
    generatedAt: string;
  } {
    const now = Date.now();
    const inFlight = [...this.inFlight.values()].map((request) => {
      const estimatedOutputTokens = request.outputUtf8Bytes / 4;
      const generationMs = request.firstTextAt === null ? 0 : Math.max(1, now - request.firstTextAt);
      return {
        id: request.id,
        timestamp: request.timestamp,
        protocol: request.protocol,
        path: request.path,
        requestedModel: request.requestedModel,
        selectedModel: request.selectedModel,
        stream: request.stream,
        phase: request.phase,
        attemptCount: request.attemptCount,
        ttftMs: request.ttftMs,
        durationMs: Math.max(0, now - new Date(request.timestamp).getTime()),
        estimatedOutputTokens,
        estimatedOutputTokensPerSecond: request.firstTextAt === null
          ? null
          : estimatedOutputTokens * 1_000 / generationMs
      };
    });
    const { series: _series, ...persisted } = structuredClone(this.state);
    return {
      ...persisted,
      health: structuredClone(health),
      inFlight,
      generatedAt: new Date().toISOString()
    };
  }

  history(limit = 500): { samples: MetricSample[]; retained: number; generatedAt: string } {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 5_000));
    return {
      samples: structuredClone(this.state.series.slice(-bounded)),
      retained: this.state.series.length,
      generatedAt: new Date().toISOString()
    };
  }

  live(): {
    inFlight: InFlightSnapshot[];
    recent: RequestRecord[];
    completedRequests: number;
    generatedAt: string;
  } {
    const snapshot = this.snapshot([]);
    return {
      inFlight: snapshot.inFlight,
      recent: snapshot.recent.slice(0, 20),
      completedRequests: snapshot.totals.requests,
      generatedAt: snapshot.generatedAt
    };
  }

  prometheus(health: ModelHealth[]): string {
    const lines = [
      "# HELP agentrouter_router_requests_total Completed proxy requests.",
      "# TYPE agentrouter_router_requests_total counter",
      `agentrouter_router_requests_total ${this.state.totals.requests}`,
      "# HELP agentrouter_router_upstream_attempts_total Upstream model calls dispatched by the proxy.",
      "# TYPE agentrouter_router_upstream_attempts_total counter",
      `agentrouter_router_upstream_attempts_total ${this.state.totals.upstreamAttempts ?? 0}`,
      "# HELP agentrouter_router_client_cancellations_total Requests cancelled by downstream clients.",
      "# TYPE agentrouter_router_client_cancellations_total counter",
      `agentrouter_router_client_cancellations_total ${this.state.totals.clientCancellations ?? 0}`,
      "# HELP agentrouter_router_request_failures_total Failed proxy requests.",
      "# TYPE agentrouter_router_request_failures_total counter",
      `agentrouter_router_request_failures_total ${this.state.totals.failures}`,
      "# HELP agentrouter_router_fallbacks_total Requests requiring more than one upstream attempt.",
      "# TYPE agentrouter_router_fallbacks_total counter",
      `agentrouter_router_fallbacks_total ${this.state.totals.fallbacks}`,
      "# HELP agentrouter_router_tokens_total Tokens reported by upstream providers.",
      "# TYPE agentrouter_router_tokens_total counter",
      `agentrouter_router_tokens_total{direction="input"} ${this.state.totals.inputTokens}`,
      `agentrouter_router_tokens_total{direction="output"} ${this.state.totals.outputTokens}`,
      `agentrouter_router_tokens_total{direction="cache_read"} ${this.state.totals.cacheReadTokens ?? 0}`,
      `agentrouter_router_tokens_total{direction="cache_write"} ${this.state.totals.cacheWriteTokens ?? 0}`,
      "# HELP agentrouter_router_estimated_cost_usd_total Estimated spend using provider ratios or catalog prices.",
      "# TYPE agentrouter_router_estimated_cost_usd_total counter",
      `agentrouter_router_estimated_cost_usd_total ${this.state.totals.estimatedCostUsd ?? 0}`,
      "# HELP agentrouter_router_reported_cost_usd_total Spend reported by upstream providers.",
      "# TYPE agentrouter_router_reported_cost_usd_total counter",
      `agentrouter_router_reported_cost_usd_total ${this.state.totals.reportedCostUsd ?? 0}`,
      "# HELP agentrouter_router_cost_usd_total Reported spend, or estimated spend when unavailable.",
      "# TYPE agentrouter_router_cost_usd_total counter",
      `agentrouter_router_cost_usd_total ${this.state.totals.costUsd ?? 0}`,
      "# HELP agentrouter_router_cost_cny_total Cost reported by AgentRouter billing events.",
      "# TYPE agentrouter_router_cost_cny_total counter",
      `agentrouter_router_cost_cny_total ${this.state.totals.costCny ?? 0}`
    ];
    lines.push(
      "# HELP agentrouter_router_inflight_requests Current downstream requests being processed.",
      "# TYPE agentrouter_router_inflight_requests gauge",
      `agentrouter_router_inflight_requests ${this.inFlight.size}`,
      "# HELP agentrouter_router_ttft_seconds_sum Sum of measured time to first semantic output.",
      "# TYPE agentrouter_router_ttft_seconds_sum counter",
      `agentrouter_router_ttft_seconds_sum ${this.state.totals.totalTtftMs / 1_000}`,
      "# HELP agentrouter_router_ttft_samples_total Requests with measured time to first semantic output.",
      "# TYPE agentrouter_router_ttft_samples_total counter",
      `agentrouter_router_ttft_samples_total ${this.state.totals.ttftSamples}`,
      "# HELP agentrouter_router_generation_seconds_sum Sum of measured output generation durations.",
      "# TYPE agentrouter_router_generation_seconds_sum counter",
      `agentrouter_router_generation_seconds_sum ${this.state.totals.totalGenerationDurationMs / 1_000}`,
      "# HELP agentrouter_router_generation_output_tokens_total Output tokens with measured generation duration.",
      "# TYPE agentrouter_router_generation_output_tokens_total counter",
      `agentrouter_router_generation_output_tokens_total ${this.state.totals.generationOutputTokens}`
    );

    for (const [aggregateKey, model] of Object.entries(this.state.byModel)) {
      const separator = aggregateKey.indexOf(":");
      const protocolName = separator === -1 ? "unknown" : aggregateKey.slice(0, separator);
      const modelName = separator === -1 ? aggregateKey : aggregateKey.slice(separator + 1);
      const label = metricLabel(modelName);
      const protocol = metricLabel(protocolName);
      lines.push(`agentrouter_router_model_attempts_total{model="${label}",protocol="${protocol}"} ${model.attempts}`);
      lines.push(`agentrouter_router_model_successes_total{model="${label}",protocol="${protocol}"} ${model.successes}`);
      lines.push(`agentrouter_router_model_failures_total{model="${label}",protocol="${protocol}"} ${model.failures}`);
      lines.push(`agentrouter_router_model_cancellations_total{model="${label}",protocol="${protocol}"} ${model.cancellations ?? 0}`);
    }
    for (const state of health) {
      const model = metricLabel(state.model);
      const protocol = metricLabel(state.protocol);
      const circuit = state.circuitState === "closed" ? 0 : state.circuitState === "half-open" ? 0.5 : 1;
      lines.push(
        `agentrouter_router_circuit_state{model="${model}",protocol="${protocol}"} ${circuit}`
      );
      if (state.latencyEwmaMs !== null) {
        lines.push(
          `agentrouter_router_model_latency_ewma_seconds{model="${model}",protocol="${protocol}"} ${state.latencyEwmaMs / 1_000}`
        );
      }
    }
    const routetok = lines.map((line) => line.replaceAll("agentrouter_router_", "routetok_"));
    return `${routetok.join("\n")}\n${lines.join("\n")}\n`;
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch((error) => console.error("Failed to persist metrics:", error));
    }, 1_000);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    const operation = this.saveQueue.then(() => this.persist());
    this.saveQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
