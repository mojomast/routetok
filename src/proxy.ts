import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { isFreeExternalCatalogModel, type CatalogService } from "./catalog.js";
import type { ConfigStore } from "./config.js";
import type { MetricsStore } from "./metrics.js";
import type { HealthRouter } from "./router.js";
import type {
  AttemptRecord,
  CatalogModel,
  Protocol,
  ProviderId,
  ProviderRuntime,
  RequestRecord,
  RoutingRequirements,
  TokenUsage
} from "./types.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_PRESTREAM_BYTES = 256 * 1024;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_REQUESTS = 100;
const MAX_ATTEMPT_HEADER_BYTES = 4_096;
const MAX_DIAGNOSTIC_ATTEMPTS = 16;
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504, 529]);
const IDENTITY_HEADERS = new Set([
  "user-agent",
  "originator",
  "version",
  "x-app",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "x-client-request-id"
]);

interface ParsedBody {
  raw: Record<string, unknown>;
  model: string;
  stream: boolean;
}

interface JsonPayload {
  bytes: Buffer;
  value: Record<string, unknown>;
  usage: TokenUsage;
}

interface PreparedStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffered: Uint8Array[];
  inspector: StreamInspector;
  firstOutputAt: number;
}

type RouterTerminal =
  | "complete"
  | "rate_limited"
  | "fallback_exhausted"
  | "non_retryable"
  | "request_timeout"
  | "client_cancelled"
  | "no_candidate"
  | "invalid_request"
  | "stream_committed";

interface DiagnosticAttempt {
  model: string;
  providerId?: ProviderId;
  status: number | null;
  outcome: string;
}

export interface RetainedRequestContent {
  capturedAt: string;
  sizeBytes: number;
  body: Record<string, unknown>;
}

interface RetainedRequestEntry {
  capturedAt: string;
  bytes: Buffer;
}

class UpstreamPayloadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function parsedError(bytes: Buffer): { code: string; message: string } {
  try {
    let value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value === "string") value = JSON.parse(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "", message: "" };
    const object = value as Record<string, unknown>;
    const error = object.error && typeof object.error === "object"
      ? object.error as Record<string, unknown>
      : object;
    return {
      code: typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "",
      message: typeof error.message === "string" ? error.message : ""
    };
  } catch {
    return { code: "", message: "" };
  }
}

function isContentFilterError(error: { code: string; message: string }): boolean {
  return /sensitive.words|content.blocked|content.filter/i.test(`${error.code} ${error.message}`);
}

function isBudgetPoolExhausted(error: { code: string; message: string }): boolean {
  return /budget.pool.*(quota|exhaust)|quota.*budget.pool/i.test(`${error.code} ${error.message}`);
}

function isModelEntitlementError(error: { code: string; message: string }): boolean {
  if (/model[_ -]?(?:access|permission|entitlement|not[_ -]?found|forbidden|unauthorized)/i.test(error.code)) return true;
  return /(?:you|account|organization|credential|api[ _-]?key).{0,80}(?:do(?:es)? not|cannot|not authorized|no longer).{0,40}(?:access|use).{0,40}(?:this |the )?model/i.test(error.message) ||
    /model.{0,100}(?:is not (?:available|accessible|allowed|enabled) (?:for|to)|requires .{0,40}(?:entitlement|subscription)|is only available on)/i.test(error.message) ||
    /only available on (?:an? )?(?:approved )?(?:agentic )?harness/i.test(error.message);
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  protocol: Protocol,
  apiKey: string,
  stripThinking = false,
  providerId: ProviderId = "agentrouter",
  internalAgentRouterRequest = false
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: headerValue(incoming, "accept") ?? "application/json"
  };
  if (providerId === "requesty" && protocol === "anthropic") headers["x-api-key"] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;

  for (const [name, value] of Object.entries(incoming)) {
    if (!value) continue;
    const normalized = name.toLowerCase();
    const preservesIdentity =
      IDENTITY_HEADERS.has(normalized) ||
      normalized.startsWith("x-stainless-") ||
      normalized.startsWith("x-claude-code-");
    if (preservesIdentity) headers[normalized] = Array.isArray(value) ? value.join(", ") : value;
  }

  if (internalAgentRouterRequest) headers["user-agent"] = "opencode/1.15.13";
  else if (!headers["user-agent"]) headers["user-agent"] = "routetok/0.1";
  if (protocol === "anthropic" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  if (stripThinking && headers["anthropic-beta"]) {
    const beta = headers["anthropic-beta"]
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && !item.toLowerCase().includes("thinking"));
    if (beta.length) headers["anthropic-beta"] = beta.join(",");
    else delete headers["anthropic-beta"];
  }
  return headers;
}

function responseHeaders(
  upstream: Headers,
  requestId: string,
  model: string,
  attempts: DiagnosticAttempt[],
  terminal: RouterTerminal,
  providerId: ProviderId = "agentrouter"
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-request-id": requestId,
    "x-router-model": model,
    "x-router-route": model,
    "x-router-provider": providerId,
    "x-router-attempts": String(attempts.length),
    "x-router-terminal": terminal,
    "x-router-attempt-summary": attemptSummary(attempts),
    "cache-control": "no-store"
  };
  for (const name of [
    "content-type",
    "retry-after",
    "request-id",
    "openai-version",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens"
  ]) {
    const value = upstream.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

// Base64url JSON avoids unsafe header characters. Fixed keys and caps keep this
// diagnostic deterministic and bounded without exposing upstream error text.
function attemptSummary(attempts: DiagnosticAttempt[]): string {
  const limited = attempts.slice(0, MAX_DIAGNOSTIC_ATTEMPTS);
  const payload = {
    v: 1,
    a: limited.map((item) => ({
      p: (item.providerId ?? "agentrouter").slice(0, 32),
      m: item.model.slice(0, 96),
      s: item.status,
      o: item.outcome.slice(0, 32)
    })),
    ...(limited.length < attempts.length ? { t: attempts.length } : {})
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded.length <= MAX_ATTEMPT_HEADER_BYTES
    ? encoded
    : Buffer.from(JSON.stringify({ v: 1, a: [], t: attempts.length })).toString("base64url");
}

function diagnosticHeaders(
  terminal: RouterTerminal,
  attempts: DiagnosticAttempt[],
  model?: string,
  providerId?: ProviderId
): Record<string, string> {
  return {
    "x-router-terminal": terminal,
    "x-router-attempts": String(attempts.length),
    "x-router-attempt-summary": attemptSummary(attempts),
    ...(model ? { "x-router-model": model, "x-router-route": model } : {}),
    ...(providerId ? { "x-router-provider": providerId } : {})
  };
}

function extractUsage(value: Record<string, unknown>): TokenUsage {
  const usage = value.usage && typeof value.usage === "object"
    ? (value.usage as Record<string, unknown>)
    : {};
  const billing = value.billing && typeof value.billing === "object"
    ? value.billing as Record<string, unknown>
    : {};
  const request = billing.request && typeof billing.request === "object"
    ? billing.request as Record<string, unknown>
    : {};
  const cost = request.cost_cny && typeof request.cost_cny === "object"
    ? request.cost_cny as Record<string, unknown>
    : {};
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as Record<string, unknown>
    : {};
  const reportedCostUsd = usage.cost === undefined ? null : decimalValue(usage.cost);
  return {
    input: numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens),
    output: numberValue(usage.completion_tokens) || numberValue(usage.output_tokens),
    cacheRead: numberValue(usage.cache_read_input_tokens) || numberValue(promptDetails.cached_tokens) || numberValue(inputDetails.cached_tokens),
    cacheWrite: numberValue(usage.cache_creation_input_tokens),
    costCny: decimalValue(cost.total),
    estimatedCostUsd: 0,
    ...(reportedCostUsd !== null ? { reportedCostUsd, costUsd: reportedCostUsd } : {})
  };
}

function estimateCostUsd(
  usage: TokenUsage,
  model: CatalogModel
): number {
  if (model.providerId && model.providerId !== "agentrouter" && model.pricing) {
    const input = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
    return (
      input * (model.pricing.input ?? 0) +
      usage.output * (model.pricing.output ?? 0) +
      usage.cacheRead * (model.pricing.cacheRead ?? model.pricing.input ?? 0) +
      usage.cacheWrite * (model.pricing.cacheWrite ?? model.pricing.input ?? 0)
    ) / 1_000_000;
  }
  const weightedTokens =
    usage.input +
    usage.cacheRead * 0.5 +
    usage.cacheWrite * 1.25 +
    usage.output * model.completionRatio;
  return weightedTokens * model.modelRatio * 0.000002;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function decimalValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSuccessfulJson(bytes: Buffer): JsonPayload {
  const text = bytes.toString("utf8");
  if (!text.trim()) throw new Error("empty upstream response");
  let value: unknown = JSON.parse(text);
  if (typeof value === "string") value = JSON.parse(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("upstream returned a non-object JSON response");
  }
  const object = value as Record<string, unknown>;
  if (object.error || object.type === "error") {
    const nested = object.error && typeof object.error === "object"
      ? object.error as Record<string, unknown>
      : {};
    const errorType = [nested.type, nested.code, object.type]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
    const retryable = /overload|server|internal|no.channel|temporar|api.error/i.test(errorType);
    throw new UpstreamPayloadError("upstream returned an error object with HTTP 200", retryable);
  }
  return {
    bytes: Buffer.from(JSON.stringify(object)),
    value: object,
    usage: extractUsage(object)
  };
}

async function readResponseBuffer(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        throw new Error(`upstream response exceeds ${Math.round(maximumBytes / 1024 / 1024)} MiB`);
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function retryAfterMs(headers: Headers): number {
  const value = headers.get("retry-after");
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, Math.min(seconds * 1_000, 3_600_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1_000, Math.min(date - Date.now(), 3_600_000)) : 30_000;
}

function attempt(
  model: string,
  status: number | null,
  durationMs: number,
  outcome: AttemptRecord["outcome"],
  error?: string,
  firstOutputMs: number | null = null,
  providerId?: ProviderId
): AttemptRecord {
  return {
    model,
    status,
    durationMs,
    firstOutputMs,
    outcome,
    ...(error ? { error } : {}),
    ...(providerId ? { providerId } : {})
  };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request body exceeds 16 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseBody(bytes: Buffer): ParsedBody {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== "string" || !raw.model.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") {
    throw new Error("stream must be a boolean");
  }
  return { raw, model: raw.model, stream: raw.stream === true };
}

function routingRequirements(body: Record<string, unknown>): RoutingRequirements {
  const inputModalities = new Set<string>();
  const outputModalities = new Set<string>();
  const pending: unknown[] = [body.messages, body.input];
  let inspected = 0;
  while (pending.length && inspected < 10_000) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    inspected += 1;
    const item = value as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    if (type === "image" || type === "image_url" || type === "input_image") inputModalities.add("image");
    if (type === "audio" || type === "input_audio") inputModalities.add("audio");
    if (item.source && typeof item.source === "object") {
      const mediaType = (item.source as Record<string, unknown>).media_type;
      if (typeof mediaType === "string" && mediaType.startsWith("image/")) inputModalities.add("image");
      if (typeof mediaType === "string" && mediaType.startsWith("audio/")) inputModalities.add("audio");
    }
    if (Array.isArray(item.content)) pending.push(item.content);
  }
  if (Array.isArray(body.modalities)) {
    for (const modality of body.modalities) {
      if (typeof modality === "string" && modality !== "text") outputModalities.add(modality);
    }
  }
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    inputModalities: [...inputModalities],
    outputModalities: [...outputModalities]
  };
}

export function thinkingPinnedModel(
  protocol: Protocol,
  body: Record<string, unknown>,
  requestedModel: string,
  customVirtual = false
): string | null {
  if (protocol !== "anthropic") return null;
  const thinkingEnabled = Boolean(body.thinking && typeof body.thinking === "object");
  const virtualModel = customVirtual || ["best", "auto", "agentrouter-best", "agentrouter-auto"].includes(requestedModel);
  const hasSignedThinking = hasSignedThinkingHistory(body);
  if (hasSignedThinking) {
    return requestedModel.startsWith("claude-") ? requestedModel : "claude-opus-5";
  }
  if (!thinkingEnabled) return null;
  if (requestedModel.startsWith("claude-")) return requestedModel;
  return virtualModel ? "claude-opus-5" : null;
}

export function hasSignedThinkingHistory(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const value = block as Record<string, unknown>;
      return (value.type === "thinking" || value.type === "redacted_thinking") &&
        typeof value.signature === "string" && value.signature.length > 0;
    });
  });
}

export function shouldStripThinkingForRequestedModel(
  protocol: Protocol,
  body: Record<string, unknown>,
  requestedModel: string,
  customVirtual = false
): boolean {
  if (protocol !== "anthropic" || !hasSignedThinkingHistory(body)) return false;
  const virtualModel = customVirtual || ["best", "auto", "agentrouter-best", "agentrouter-auto"].includes(requestedModel);
  return !virtualModel && !requestedModel.startsWith("claude-");
}

export function stripThinkingForFallback(body: Record<string, unknown>): Record<string, unknown> {
  const transformed = structuredClone(body);
  delete transformed.thinking;
  if (!Array.isArray(transformed.messages)) return transformed;

  transformed.messages = transformed.messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [message];
    const value = message as Record<string, unknown>;
    if (!Array.isArray(value.content)) return [value];
    const content = value.content.filter((block) => {
      if (!block || typeof block !== "object") return true;
      const type = (block as Record<string, unknown>).type;
      return type !== "thinking" && type !== "redacted_thinking";
    });
    value.content = content;
    return content.length === 0 ? [] : [value];
  });
  return transformed;
}

export function flattenAgentRouterDeepSeekToolHistory(body: Record<string, unknown>): Record<string, unknown> {
  const transformed = structuredClone(body);
  if (!Array.isArray(transformed.messages)) return transformed;
  transformed.messages = transformed.messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const value = message as Record<string, unknown>;
    if (!Array.isArray(value.content)) return value;
    value.content = value.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const item = block as Record<string, unknown>;
      if (item.type === "tool_use") {
        const name = typeof item.name === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(item.name) ? item.name : "tool";
        return { type: "text", text: `[Historical tool call: ${name}]` };
      }
      if (item.type === "tool_result") {
        const result = typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : "").filter(Boolean).join("\n")
            : "";
        return { type: "text", text: `[Historical tool result${item.is_error === true ? " error" : ""}]${result ? `\n${result}` : ""}` };
      }
      return item;
    });
    return value;
  });
  return transformed;
}

function protocolError(protocol: Protocol, requestId: string, message: string, code: string): object {
  if (protocol === "anthropic") {
    return {
      type: "error",
      error: { type: code, message },
      request_id: requestId
    };
  }
  return {
    error: {
      message,
      type: code,
      param: null,
      code
    }
  };
}

function sendJson(response: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    ...headers
  });
  response.end(bytes);
}

function streamEventBlocks(buffer: string): { blocks: string[]; remainder: string } {
  const blocks: string[] = [];
  const separator = /\r\n\r\n|\n\n|\r\r/g;
  let cursor = 0;
  for (let match = separator.exec(buffer); match; match = separator.exec(buffer)) {
    blocks.push(buffer.slice(cursor, match.index).replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
    cursor = match.index + match[0].length;
  }
  return { blocks, remainder: buffer.slice(cursor) };
}

function sseFields(block: string): { event: string; data: string } {
  const lines = block.split("\n");
  return {
    event: lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "",
    data: lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
  };
}

class StreamSanitizer {
  private readonly decoder = new TextDecoder();
  private pending = "";

  constructor(
    private readonly protocol: Protocol,
    private readonly path: string,
    private readonly model: string
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const { blocks, remainder } = streamEventBlocks(this.pending);
    this.pending = remainder;
    return blocks.flatMap((block) => this.sanitize(block));
  }

  finish(): Uint8Array[] {
    this.pending += this.decoder.decode();
    const final = this.pending.trim() ? this.sanitize(this.pending) : [];
    this.pending = "";
    return final;
  }

  private sanitize(block: string): Uint8Array[] {
    const { event, data } = sseFields(block);
    if (!data) return [];
    if (data === "[DONE]") {
      return this.protocol === "openai" ? [Buffer.from("data: [DONE]\n\n")] : [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const value = parsed as Record<string, unknown>;
    const type = typeof value.type === "string" ? value.type : event;
    const object = typeof value.object === "string" ? value.object : "";
    if (
      event === "billing_summary" ||
      object === "billing.summary" ||
      type === "billing_summary" ||
      value.billing
    ) return [];

    if (this.protocol === "openai") {
      const responsesWire = this.path.endsWith("/responses");
      const allowed = responsesWire
        ? type.startsWith("response.") || Boolean(value.error)
        : Array.isArray(value.choices) || Boolean(value.error);
      if (!allowed) return [];
      value.model = this.model;
      const prefix = responsesWire && event ? `event: ${event}\n` : "";
      return [Buffer.from(`${prefix}data: ${JSON.stringify(value)}\n\n`)];
    }

    const allowedTypes = new Set([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
      "ping",
      "error"
    ]);
    if (!allowedTypes.has(type)) return [];
    if (type === "message_start" && value.message && typeof value.message === "object") {
      (value.message as Record<string, unknown>).model = this.model;
    }
    return [Buffer.from(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)];
  }
}

function hasSemanticValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

export class StreamInspector {
  private readonly decoder = new TextDecoder();
  private pending = "";
  readonly usage: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costCny: 0,
    estimatedCostUsd: 0
  };
  meaningful = false;
  terminal = false;
  upstreamError: string | null = null;
  outputUtf8Bytes = 0;
  firstTextAt: number | null = null;

  constructor(private readonly protocol: Protocol) {}

  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const { blocks, remainder } = streamEventBlocks(this.pending);
    this.pending = remainder;
    for (const block of blocks) this.inspectBlock(block);
  }

  finish(): void {
    this.pending += this.decoder.decode();
    if (this.pending.trim()) this.inspectBlock(this.pending);
    this.pending = "";
  }

  private captureText(value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    this.firstTextAt ??= Date.now();
    this.outputUtf8Bytes += Buffer.byteLength(value, "utf8");
  }

  private inspectBlock(block: string): void {
    const { event, data } = sseFields(block);
    if (!data) return;
    if (data === "[DONE]") {
      if (this.protocol === "openai") this.terminal = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const value = parsed as Record<string, unknown>;
    const type = typeof value.type === "string" ? value.type : event;
    const object = typeof value.object === "string" ? value.object : "";

    const responseObject = value.response && typeof value.response === "object"
      ? value.response as Record<string, unknown>
      : {};
    if (value.error || responseObject.error || type === "error" || type === "response.failed") {
      this.upstreamError = "upstream stream error";
    }
    if (this.protocol === "anthropic") {
      if (type === "content_block_start") {
        const block = value.content_block && typeof value.content_block === "object"
          ? value.content_block as Record<string, unknown>
          : {};
        this.meaningful ||= block.type === "tool_use" ||
          hasSemanticValue(block.text) || hasSemanticValue(block.thinking) || hasSemanticValue(block.data);
        this.captureText(block.text);
        this.captureText(block.thinking);
      }
      if (type === "content_block_delta") {
        const delta = value.delta && typeof value.delta === "object"
          ? value.delta as Record<string, unknown>
          : {};
        this.meaningful ||= [
          delta.text,
          delta.partial_json,
          delta.thinking,
          delta.signature,
          delta.data
        ].some(hasSemanticValue);
        this.captureText(delta.text);
        this.captureText(delta.thinking);
      }
      if (type === "message_stop") this.terminal = true;
    } else {
      const choices = Array.isArray(value.choices) ? value.choices : [];
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const choiceObject = choice as Record<string, unknown>;
        const delta = choiceObject.delta && typeof choiceObject.delta === "object"
          ? choiceObject.delta as Record<string, unknown>
          : {};
        this.meaningful ||= [
          delta.content,
          delta.reasoning,
          delta.reasoning_content,
          delta.refusal,
          delta.tool_calls,
          delta.function_call
        ].some(hasSemanticValue);
        this.captureText(delta.content);
        this.captureText(typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning);
        this.captureText(delta.refusal);
      }
      if (/\.delta$/.test(type)) {
        this.meaningful ||= hasSemanticValue(value.delta);
        if (/output_text|reasoning/i.test(type)) this.captureText(value.delta);
      }
      if (type === "response.output_item.added") {
        const item = value.item && typeof value.item === "object" ? value.item as Record<string, unknown> : {};
        this.meaningful ||= item.type === "function_call" || item.type === "tool_call";
      }
      if (["response.completed", "response.failed", "response.incomplete"].includes(type)) {
        this.terminal = true;
      }
    }

    this.captureUsage(value);
    this.captureUsage(responseObject);
    if (value.message && typeof value.message === "object") {
      this.captureUsage(value.message as Record<string, unknown>);
    }
    if (object === "billing.summary" && value.billing && typeof value.billing === "object") {
      const billing = value.billing as Record<string, unknown>;
      const request = billing.request;
      if (request && typeof request === "object") {
        const tokens = (request as Record<string, unknown>).tokens;
        if (tokens && typeof tokens === "object") this.captureUsage({ usage: tokens });
        const cost = (request as Record<string, unknown>).cost_cny;
        if (cost && typeof cost === "object") {
          this.usage.costCny = Math.max(
            this.usage.costCny,
            decimalValue((cost as Record<string, unknown>).total)
          );
        }
      }
    }
  }

  private captureUsage(value: Record<string, unknown>): void {
    const usage = extractUsage(value);
    this.usage.input = Math.max(this.usage.input, usage.input);
    this.usage.output = Math.max(this.usage.output, usage.output);
    this.usage.cacheRead = Math.max(this.usage.cacheRead, usage.cacheRead);
    this.usage.cacheWrite = Math.max(this.usage.cacheWrite, usage.cacheWrite);
    this.usage.costCny = Math.max(this.usage.costCny, usage.costCny);
    if (usage.reportedCostUsd !== undefined) {
      this.usage.reportedCostUsd = Math.max(this.usage.reportedCostUsd ?? 0, usage.reportedCostUsd);
      this.usage.costUsd = this.usage.reportedCostUsd;
    }
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  message = "timed out waiting for stream data"
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function prepareStream(
  upstream: Response,
  protocol: Protocol,
  timeoutMs: number
): Promise<PreparedStream> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`expected text/event-stream, received ${contentType || "unknown content type"}`);
  }
  if (!upstream.body) throw new Error("upstream stream has no body");

  const reader = upstream.body.getReader();
  const buffered: Uint8Array[] = [];
  const inspector = new StreamInspector(protocol);
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;
  try {
    while (!inspector.meaningful) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("model produced no semantic output before the attempt deadline");
      const result = await readWithTimeout(
        reader,
        remainingMs,
        "model produced no semantic output before the attempt deadline"
      );
      if (result.done) throw new Error("upstream stream ended before producing output");
      bytes += result.value.byteLength;
      if (bytes > MAX_PRESTREAM_BYTES) throw new Error("upstream sent too much metadata before output");
      buffered.push(result.value);
      inspector.push(result.value);
      if (inspector.upstreamError) throw new Error(inspector.upstreamError);
      if (inspector.terminal && !inspector.meaningful) {
        throw new Error("upstream stream completed without output");
      }
    }
    return { reader, buffered, inspector, firstOutputAt: Date.now() };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("client disconnected"));
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

async function writeStreamError(response: ServerResponse, protocol: Protocol): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  const payload = protocol === "anthropic"
    ? `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Upstream stream stalled or disconnected" }
      })}\n\n`
    : `data: ${JSON.stringify({
        error: {
          message: "Upstream stream stalled or disconnected",
          type: "server_error",
          code: "stream_interrupted"
        }
      })}\n\n`;
  await writeChunk(response, Buffer.from(payload));
}

export interface ProxyHandlerOptions {
  apiKey?: string;
  baseUrl?: string;
  providers?: ProviderRuntime[];
  catalog: CatalogService;
  config: ConfigStore;
  router: HealthRouter;
  metrics: MetricsStore;
  internalToken?: string;
  fetch?: typeof fetch;
}

export class ProxyHandler {
  private readonly fetchImpl: typeof fetch;
  private readonly retainedRequests = new Map<string, RetainedRequestEntry>();
  private retainedRequestBytes = 0;

  constructor(private readonly options: ProxyHandlerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private provider(id: ProviderId): ProviderRuntime | undefined {
    if (this.options.providers) return this.options.providers.find((provider) => provider.id === id && provider.configured);
    if (id === "agentrouter" && this.options.apiKey && this.options.baseUrl) {
      return { id, configured: true, apiKey: this.options.apiKey, baseUrl: this.options.baseUrl };
    }
    return undefined;
  }

  private endpoint(provider: ProviderRuntime, path: string): string {
    if (provider.id === "agentrouter") return `${provider.baseUrl}${path}`;
    const normalizedPath = path.startsWith("/v1/") && provider.baseUrl.endsWith("/v1") ? path.slice(3) : path;
    return `${provider.baseUrl}${normalizedPath}`;
  }

  getRetainedRequestContent(requestId: string): RetainedRequestContent | null {
    const retained = this.retainedRequests.get(requestId);
    if (!retained) return null;
    return {
      capturedAt: retained.capturedAt,
      sizeBytes: retained.bytes.byteLength,
      body: JSON.parse(retained.bytes.toString("utf8")) as Record<string, unknown>
    };
  }

  private retainRequestContent(requestId: string, bytes: Buffer): void {
    if (bytes.byteLength > MAX_RETAINED_REQUEST_BYTES) return;
    const retained = {
      capturedAt: new Date().toISOString(),
      bytes: Buffer.from(bytes)
    };
    this.retainedRequests.set(requestId, retained);
    this.retainedRequestBytes += retained.bytes.byteLength;
    while (
      this.retainedRequests.size > MAX_RETAINED_REQUESTS ||
      this.retainedRequestBytes > MAX_RETAINED_CONTENT_BYTES
    ) {
      const oldestId = this.retainedRequests.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.retainedRequests.get(oldestId);
      this.retainedRequests.delete(oldestId);
      this.retainedRequestBytes -= oldest?.bytes.byteLength ?? 0;
    }
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    protocol: Protocol
  ): Promise<void> {
    const requestId = randomUUID();
    const requestStarted = Date.now();
    const internalSandbox = Boolean(this.options.internalToken) &&
      (request.headers["x-routetok-internal"] === this.options.internalToken || request.headers["x-agentrouter-internal"] === this.options.internalToken);
    let parsed: ParsedBody;
    try {
      const requestBytes = await readRequestBody(request);
      parsed = parseBody(requestBytes);
      if (!internalSandbox) {
        this.retainRequestContent(requestId, requestBytes);
      }
    } catch (error) {
      const status = (error as Error).message.includes("16 MiB") ? 413 : 400;
      sendJson(
        response,
        status,
        protocolError(protocol, requestId, (error as Error).message, "invalid_request"),
        { "x-request-id": requestId, ...diagnosticHeaders("invalid_request", []) }
      );
      this.options.metrics.record({
        id: requestId,
        timestamp: new Date(requestStarted).toISOString(),
        protocol,
        path,
        requestedModel: "(invalid)",
        selectedModel: null,
        stream: false,
        status,
        durationMs: Date.now() - requestStarted,
        ttftMs: null,
        generationDurationMs: null,
        outputTokensPerSecond: null,
        attempts: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costCny: 0, estimatedCostUsd: 0 },
        error: (error as Error).message,
        trafficClass: internalSandbox ? "sandbox" : "client"
      });
      return;
    }

    this.options.metrics.beginInFlight({
      id: requestId,
      timestamp: new Date(requestStarted).toISOString(),
      protocol,
      path,
      requestedModel: parsed.model,
      selectedModel: null,
      stream: parsed.stream,
      phase: "routing",
      attemptCount: 0,
      ttftMs: null,
      outputUtf8Bytes: 0,
      firstTextAt: null
    });

    const config = this.options.config.get();
    if (internalSandbox) {
      config.fallbackExplicitModels = false;
      config.maxAttempts = 1;
    }
    void this.options.catalog.refreshIfStale(config.catalogRefreshHours);
    const endpointKind = path.endsWith("/responses") ? "responses" : path.endsWith("/messages") ? "messages" : "chat";
    const endpointModels = this.options.catalog.getModels(protocol)
      .filter((model) => !model.endpoints || model.endpoints.includes(endpointKind));
    const requestedCatalogModel = endpointModels.find((model) => model.id === parsed.model);
    const paidOpenRouterFallbackActive = requestedCatalogModel?.providerId === "openrouter" &&
      !isFreeExternalCatalogModel(requestedCatalogModel) && config.paidOpenRouterFallbackOrder.length > 0;
    let candidates = this.options.router.candidates(
      protocol,
      parsed.model,
      endpointModels,
      config,
      routingRequirements(parsed.raw)
    );
    const customVirtual = config.customCascades.some((cascade) => cascade.name === parsed.model);
    const stripThinkingOnFirstAttempt = config.thinkingFallbackMode === "strip" &&
      shouldStripThinkingForRequestedModel(protocol, parsed.raw, parsed.model, customVirtual);
    const pinnedModel = stripThinkingOnFirstAttempt
      ? null
      : thinkingPinnedModel(protocol, parsed.raw, parsed.model, customVirtual);
    if (pinnedModel && config.thinkingFallbackMode === "pin") {
      candidates = candidates.filter((model) => model === pinnedModel).slice(0, 1);
    } else if (pinnedModel && candidates.includes(pinnedModel)) {
      candidates = [pinnedModel, ...candidates.filter((model) => model !== pinnedModel)];
    }
    if (candidates.length === 0) {
      sendJson(
        response,
        503,
        protocolError(protocol, requestId, "No healthy compatible RouteTok model is available", "no_candidate"),
        { "x-request-id": requestId, "retry-after": "30", ...diagnosticHeaders("no_candidate", []) }
      );
      this.options.metrics.record({
        id: requestId,
        timestamp: new Date(requestStarted).toISOString(),
        protocol,
        path,
        requestedModel: parsed.model,
        selectedModel: null,
        stream: parsed.stream,
        status: 503,
        durationMs: Date.now() - requestStarted,
        ttftMs: null,
        generationDurationMs: null,
        outputTokensPerSecond: null,
        attempts: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costCny: 0, estimatedCostUsd: 0 },
        error: "no healthy compatible model",
        trafficClass: internalSandbox ? "sandbox" : "client"
      });
      return;
    }

    const attempts: AttemptRecord[] = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("request deadline exceeded")), config.requestTimeoutMs);
    timeout.unref();
    let clientAborted = false;
    request.once("aborted", () => {
      clientAborted = true;
      controller.abort(new Error("client disconnected"));
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        clientAborted = true;
        controller.abort(new Error("client disconnected"));
      }
    });

    let finalStatus = 502;
    let finalError: string | null = "all upstream attempts failed";
    let selectedModel: string | null = null;
    let ttftMs: number | null = null;
    let generationDurationMs: number | null = null;
    let outputTokensPerSecond: number | null = null;
    let usage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costCny: 0,
      estimatedCostUsd: 0
    };

    try {
      for (const model of candidates) {
        const catalogModel = this.options.catalog.resolve(model, protocol);
        const providerId = catalogModel?.providerId ?? "agentrouter";
        const provider = this.provider(providerId);
        if (!catalogModel || !provider) continue;
        const started = Date.now();
        const attemptBudgetMs = model.startsWith("claude-") || providerId === "opencode" || providerId === "kimi"
          ? config.slowModelFirstEventTimeoutMs
          : config.firstEventTimeoutMs;
        const attemptDeadline = started + attemptBudgetMs;
        const attemptController = new AbortController();
        const attemptTimeout = setTimeout(
          () => attemptController.abort(new Error("model first-output deadline exceeded")),
          attemptBudgetMs
        );
        attemptTimeout.unref();
        const attemptSignal = AbortSignal.any([controller.signal, attemptController.signal]);
        if (!internalSandbox) this.options.router.startAttempt(protocol, model);
        this.options.metrics.updateInFlight(requestId, {
          phase: "attempting",
          selectedModel: model,
          attemptCount: attempts.length + 1
        });
        try {
        const stripThinking = Boolean(
          config.thinkingFallbackMode === "strip" &&
          (stripThinkingOnFirstAttempt || pinnedModel && model !== pinnedModel)
        );
        let attemptBody = stripThinking ? stripThinkingForFallback(parsed.raw) : parsed.raw;
        if (providerId === "agentrouter" && protocol === "anthropic" && model.startsWith("deepseek-")) {
          attemptBody = flattenAgentRouterDeepSeekToolHistory(attemptBody);
        }
        const body = JSON.stringify({ ...attemptBody, model: catalogModel.upstreamId ?? model });
        let upstream: Response;
        try {
          const upstreamHeaders = buildUpstreamHeaders(request.headers, protocol, provider.apiKey, stripThinking, providerId, internalSandbox && providerId === "agentrouter");
          if (provider.auth === "none") delete upstreamHeaders.authorization;
          upstream = await this.fetchImpl(this.endpoint(provider, path), {
            method: "POST",
            headers: upstreamHeaders,
            body,
            redirect: "manual",
            signal: attemptSignal
          });
        } catch (error) {
          clearTimeout(attemptTimeout);
          const duration = Date.now() - started;
          if (clientAborted) {
            attempts.push(attempt(model, null, duration, "cancelled", "client_disconnected", null, providerId));
            selectedModel = model;
            finalStatus = 499;
            finalError = "client disconnected";
            return;
          }
          const overallTimedOut = controller.signal.aborted;
          const attemptTimedOut = attemptController.signal.aborted;
          const message = overallTimedOut
            ? "request deadline exceeded"
            : attemptTimedOut
              ? "model produced no output before the attempt deadline"
              : "upstream connection failed";
          attempts.push(attempt(model, null, duration, "transient_error", message, null, providerId));
          if (!internalSandbox) this.options.router.recordTransientFailure(protocol, model, config);
          finalStatus = overallTimedOut || attemptTimedOut ? 504 : 502;
          finalError = message;
          if (overallTimedOut) break;
          continue;
        }

        // A non-stream response is not committed until its complete JSON body is
        // buffered and validated, so keep the first-output deadline active.
        const duration = Date.now() - started;
        if (upstream.status === 429) {
          attempts.push(attempt(model, 429, duration, "rate_limited", "HTTP 429", null, providerId));
          if (!internalSandbox) this.options.router.recordRateLimit(protocol, model, retryAfterMs(upstream.headers));
          finalStatus = 429;
          finalError = "rate limited";
          if (paidOpenRouterFallbackActive && attempts.length < candidates.length) {
            await upstream.body?.cancel().catch(() => {});
            continue;
          }
          const terminal = paidOpenRouterFallbackActive && candidates.length > 1 ? "fallback_exhausted" : "rate_limited";
          await upstream.body?.cancel().catch(() => {});
          const retryAfter = upstream.headers.get("retry-after");
          sendJson(
            response,
            429,
            protocolError(protocol, requestId, terminal === "fallback_exhausted" ? "All RouteTok fallback attempts were rate limited" : "The upstream model is rate limited", terminal),
            {
              "x-request-id": requestId,
              ...diagnosticHeaders(terminal, attempts, model, providerId),
              ...(retryAfter ? { "retry-after": retryAfter } : {})
            }
          );
          selectedModel = model;
          break;
        }
        if (!upstream.ok) {
          const errorBytes = await readResponseBuffer(upstream, MAX_ERROR_RESPONSE_BYTES)
            .catch(() => Buffer.alloc(0));
          const upstreamError = parsedError(errorBytes);
          if (upstream.status === 403) {
            const entitlementError = isModelEntitlementError(upstreamError);
            attempts.push(attempt(model, 403, duration, "permanent_error", "HTTP 403", null, providerId));
            if (!internalSandbox) {
              if (entitlementError) this.options.router.recordEntitlementFailure(protocol, model);
              else this.options.router.recordPermanentFailure(protocol, model);
            }
            await this.forwardResponse(response, upstream, requestId, model, attempts, protocol, "non_retryable", errorBytes, undefined, providerId);
            finalStatus = 403;
            finalError = entitlementError ? "model is not entitled for this credential" : "upstream returned HTTP 403";
            selectedModel = model;
            break;
          }
          if (providerId === "agentrouter" && isContentFilterError(upstreamError)) {
            attempts.push(attempt(model, 400, duration, "permanent_error", "content_filter", null, providerId));
            await this.forwardResponse(
              response,
              upstream,
              requestId,
              model,
              attempts,
              protocol,
              "non_retryable",
              errorBytes,
              400,
              providerId
            );
            finalStatus = 400;
            finalError = "request rejected by AgentRouter content filtering";
            selectedModel = model;
            break;
          }
          if (providerId === "agentrouter" && upstream.status === 402 && isBudgetPoolExhausted(upstreamError)) {
            attempts.push(attempt(model, 402, duration, "rate_limited", "budget_pool_exhausted", null, providerId));
            if (!internalSandbox) this.options.router.recordRateLimit(protocol, model, 300_000);
            finalStatus = 402;
            finalError = "AgentRouter model budget pool exhausted";
            if (attempts.length < candidates.length) continue;
            const terminal = attempts.length > 1 ? "fallback_exhausted" : "rate_limited";
            await this.forwardResponse(
              response,
              upstream,
              requestId,
              model,
              attempts,
              protocol,
              terminal,
              errorBytes,
              undefined,
              providerId
            );
            selectedModel = model;
            break;
          }
          if (TRANSIENT_STATUSES.has(upstream.status)) {
            attempts.push(
              attempt(model, upstream.status, duration, "transient_error", `HTTP ${upstream.status}`, null, providerId)
            );
            if (!internalSandbox) this.options.router.recordTransientFailure(protocol, model, config);
            finalStatus = upstream.status;
            finalError = `upstream returned HTTP ${upstream.status}`;
            continue;
          } else {
            attempts.push(
              attempt(model, upstream.status, duration, "permanent_error", `HTTP ${upstream.status}`, null, providerId)
            );
            if (!internalSandbox) this.options.router.recordPermanentFailure(protocol, model);
          }
          await this.forwardResponse(
            response,
            upstream,
            requestId,
            model,
            attempts,
            protocol,
            "non_retryable",
            errorBytes,
            undefined,
            providerId
          );
          finalStatus = upstream.status;
          finalError = `upstream returned HTTP ${upstream.status}`;
          selectedModel = model;
          break;
        }

        if (parsed.stream) {
          let prepared: PreparedStream;
          try {
            prepared = await prepareStream(
              upstream,
              protocol,
              Math.max(1, attemptDeadline - Date.now())
            );
          } catch (error) {
            if (clientAborted) {
              attempts.push(
                attempt(model, upstream.status, Date.now() - started, "cancelled", "client_disconnected", null, providerId)
              );
              selectedModel = model;
              finalStatus = 499;
              finalError = "client disconnected";
              return;
            }
            const message = attemptController.signal.aborted
              ? "model produced no output before the attempt deadline"
              : (error as Error).message;
            attempts.push(attempt(model, upstream.status, Date.now() - started, "transient_error", message, null, providerId));
            if (!internalSandbox) this.options.router.recordTransientFailure(protocol, model, config);
            finalStatus = message.includes("deadline") ? 504 : 502;
            finalError = message;
            continue;
          } finally {
            clearTimeout(attemptTimeout);
          }

          selectedModel = model;
          const firstOutputMs = prepared.firstOutputAt - started;
          ttftMs = prepared.firstOutputAt - requestStarted;
          this.options.metrics.updateInFlight(requestId, {
            phase: "streaming",
            selectedModel: model,
            attemptCount: attempts.length + 1,
            ttftMs,
            outputUtf8Bytes: prepared.inspector.outputUtf8Bytes,
            firstTextAt: prepared.inspector.firstTextAt
          });
          const streamResult = await this.pipeStream(
            response,
            upstream,
            prepared,
            requestId,
            model,
            attempts,
            protocol,
              config.streamIdleTimeoutMs,
              path,
              providerId
          );
          const streamCompletedAt = Date.now();
          usage = streamResult.usage;
          generationDurationMs = Math.max(0, streamCompletedAt - prepared.firstOutputAt);
          outputTokensPerSecond = usage.output > 0 && generationDurationMs > 0
            ? usage.output * 1_000 / generationDurationMs
            : null;
          const pricing = this.options.catalog.getModels().find((entry) => entry.id === model);
          if (pricing) {
            usage.estimatedCostUsd = usage.reportedCostUsd === undefined ? estimateCostUsd(usage, pricing) : 0;
            usage.costUsd = usage.reportedCostUsd ?? usage.estimatedCostUsd;
          }
          if (clientAborted) {
            attempts.push(
              attempt(model, 200, Date.now() - started, "cancelled", "client_disconnected", firstOutputMs, providerId)
            );
            finalStatus = 499;
            finalError = "client disconnected";
            return;
          }
          finalStatus = 200;
          finalError = streamResult.error;
          if (streamResult.error) {
            attempts.push(
              attempt(model, 200, Date.now() - started, "transient_error", streamResult.error, firstOutputMs, providerId)
            );
            if (!internalSandbox) this.options.router.recordTransientFailure(protocol, model, config);
          } else {
            attempts.push(attempt(model, 200, Date.now() - started, "success", undefined, firstOutputMs, providerId));
            if (!internalSandbox) this.options.router.recordSuccess(protocol, model, Date.now() - started, config);
          }
          break;
        }

        let payload: JsonPayload;
        try {
          const bytes = await readResponseBuffer(upstream, MAX_JSON_RESPONSE_BYTES);
          const contentType = upstream.headers.get("content-type") ?? "";
          if (contentType.includes("text/html")) throw new Error("upstream returned an HTML challenge");
          payload = parseSuccessfulJson(bytes);
        } catch (error) {
          if (clientAborted) {
            attempts.push(
              attempt(model, upstream.status, Date.now() - started, "cancelled", "client_disconnected", null, providerId)
            );
            selectedModel = model;
            finalStatus = 499;
            finalError = "client disconnected";
            return;
          }
          const overallTimedOut = controller.signal.aborted;
          const attemptTimedOut = attemptController.signal.aborted;
          const message = overallTimedOut
            ? "request deadline exceeded"
            : attemptTimedOut
              ? "model produced no output before the attempt deadline"
              : (error as Error).message;
          const retryable = !overallTimedOut && (!(error instanceof UpstreamPayloadError) || error.retryable);
          attempts.push(attempt(
            model,
            upstream.status,
            Date.now() - started,
            retryable ? "transient_error" : "permanent_error",
            message,
            null,
            providerId
          ));
          if (!internalSandbox) {
            if (retryable) this.options.router.recordTransientFailure(protocol, model, config);
            else this.options.router.recordPermanentFailure(protocol, model);
          }
          finalStatus = overallTimedOut || attemptTimedOut ? 504 : 502;
          finalError = message;
          if (retryable) continue;
          break;
        }

        selectedModel = model;
        payload.value.model = model;
        payload.bytes = Buffer.from(JSON.stringify(payload.value));
        usage = payload.usage;
        const pricing = this.options.catalog.getModels().find((entry) => entry.id === model);
        if (pricing) {
          usage.estimatedCostUsd = usage.reportedCostUsd === undefined ? estimateCostUsd(usage, pricing) : 0;
          usage.costUsd = usage.reportedCostUsd ?? usage.estimatedCostUsd;
        }
        attempts.push(attempt(model, upstream.status, Date.now() - started, "success", undefined, null, providerId));
        if (!internalSandbox) this.options.router.recordSuccess(protocol, model, Date.now() - started, config);
        response.writeHead(upstream.status, {
          ...responseHeaders(upstream.headers, requestId, model, attempts, "complete", providerId),
          "content-type": "application/json; charset=utf-8",
          "content-length": String(payload.bytes.length)
        });
        response.end(payload.bytes);
        finalStatus = upstream.status;
        finalError = null;
        break;
        } finally {
          clearTimeout(attemptTimeout);
          if (!internalSandbox) this.options.router.finishAttempt(protocol, model);
        }
      }

      if (!response.headersSent && !clientAborted) {
        const lastAttempt = attempts.at(-1);
        const terminal: RouterTerminal = attempts.length === 0
          ? "no_candidate"
          : controller.signal.aborted
            ? "request_timeout"
            : finalStatus === 504 && attempts.length === 1 && finalError?.includes("deadline")
              ? "request_timeout"
              : attempts.some((item) => item.outcome === "transient_error" || item.outcome === "rate_limited")
                ? "fallback_exhausted"
                : "non_retryable";
        if (terminal === "no_candidate") {
          finalStatus = 503;
          finalError = "no configured provider is available for the routed candidates";
        }
        selectedModel ??= lastAttempt?.model ?? null;
        sendJson(
          response,
          finalStatus,
          protocolError(protocol, requestId, finalError ?? "RouteTok request failed", terminal),
          {
            "x-request-id": requestId,
            ...diagnosticHeaders(terminal, attempts, lastAttempt?.model, lastAttempt?.providerId)
          }
        );
      }
    } finally {
      clearTimeout(timeout);
      if (clientAborted) {
        finalStatus = 499;
        finalError = "client disconnected";
      }
      const record: RequestRecord = {
        id: requestId,
        timestamp: new Date(requestStarted).toISOString(),
        protocol,
        path,
        requestedModel: parsed.model,
        selectedModel,
        stream: parsed.stream,
        status: finalStatus,
        durationMs: Date.now() - requestStarted,
        ttftMs,
        generationDurationMs,
        outputTokensPerSecond,
        attempts,
        usage,
        error: finalError,
        provider: selectedModel ? this.options.catalog.resolve(selectedModel)?.providerId ?? "agentrouter" : null,
        trafficClass: internalSandbox ? "sandbox" : "client"
      };
      this.options.metrics.record(record);
    }
  }

  private async forwardResponse(
    response: ServerResponse,
    upstream: Response,
    requestId: string,
    model: string,
    attempts: AttemptRecord[],
    protocol: Protocol,
    terminal: RouterTerminal,
    suppliedBytes?: Buffer,
    statusOverride?: number,
    providerId: ProviderId = "agentrouter"
  ): Promise<void> {
    const upstreamBytes = suppliedBytes ?? await readResponseBuffer(upstream, MAX_ERROR_RESPONSE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(upstreamBytes.toString("utf8"));
      if (typeof value === "string") value = JSON.parse(value);
    } catch {
      value = null;
    }
    const object = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const valid = protocol === "anthropic"
      ? object?.type === "error" && Boolean(object.error)
      : Boolean(object?.error && typeof object.error === "object");
    const body = valid
      ? object
      : protocolError(
          protocol,
          requestId,
          `Upstream provider returned HTTP ${upstream.status} without a valid error envelope`,
          terminal
        );
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(statusOverride ?? upstream.status, {
      ...responseHeaders(upstream.headers, requestId, model, attempts, terminal, providerId),
      "content-type": "application/json; charset=utf-8",
      "content-length": String(bytes.length)
    });
    response.end(bytes);
  }

  private async pipeStream(
    response: ServerResponse,
    upstream: Response,
    prepared: PreparedStream,
    requestId: string,
    model: string,
    priorAttempts: AttemptRecord[],
    protocol: Protocol,
    idleTimeoutMs: number,
    path: string,
    providerId: ProviderId
  ): Promise<{ usage: TokenUsage; error: string | null }> {
    const headerAttempts: DiagnosticAttempt[] = [
      ...priorAttempts,
      { model, providerId, status: upstream.status, outcome: "stream_committed" }
    ];
    response.writeHead(
      upstream.status,
      responseHeaders(upstream.headers, requestId, model, headerAttempts, "stream_committed", providerId)
    );
    const sanitizer = new StreamSanitizer(protocol, path, model);
    try {
      for (const chunk of prepared.buffered) {
        for (const sanitized of sanitizer.push(chunk)) await writeChunk(response, sanitized);
      }
      while (true) {
        const result = await readWithTimeout(
          prepared.reader,
          idleTimeoutMs,
          "upstream stream idle timeout exceeded"
        );
        if (result.done) break;
        prepared.inspector.push(result.value);
        this.options.metrics.updateInFlight(requestId, {
          outputUtf8Bytes: prepared.inspector.outputUtf8Bytes,
          firstTextAt: prepared.inspector.firstTextAt
        });
        for (const sanitized of sanitizer.push(result.value)) await writeChunk(response, sanitized);
        if (prepared.inspector.upstreamError) {
          await prepared.reader.cancel("upstream stream reported an error").catch(() => {});
          break;
        }
      }
      prepared.inspector.finish();
      for (const sanitized of sanitizer.finish()) await writeChunk(response, sanitized);
      response.end();
      const error = prepared.inspector.upstreamError ??
        (prepared.inspector.terminal ? null : "stream ended without a terminal event");
      return { usage: prepared.inspector.usage, error };
    } catch (error) {
      await prepared.reader.cancel("downstream stream ended").catch(() => {});
      try {
        await writeStreamError(response, protocol);
        response.end();
      } catch {
        response.destroy();
      }
      return { usage: prepared.inspector.usage, error: (error as Error).message };
    }
  }
}
