export interface AttemptSummaryEntry {
  provider: string;
  model: string;
  status: number | null;
  outcome: string;
}

export interface AttemptSummarySuccess {
  ok: true;
  version: number;
  attempts: AttemptSummaryEntry[];
  total: number;
  truncated: boolean;
}

export interface AttemptSummaryFailure {
  ok: false;
  error: string;
}

export type DecodeAttemptSummaryResult = AttemptSummarySuccess | AttemptSummaryFailure;

const MAX_ENTRIES = 16;
const MAX_PROVIDER_CHARS = 32;
const MAX_MODEL_CHARS = 96;
const MAX_OUTCOME_CHARS = 32;
const MAX_HEADER_CHARS = 4096;

function failure(error: string): AttemptSummaryFailure {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAttemptSummary(header: string): DecodeAttemptSummaryResult {
  try {
    if (typeof header !== "string" || header.length === 0) return failure("empty_header");
    if (header.length > MAX_HEADER_CHARS) return failure("header_too_long");
    if (!/^[A-Za-z0-9\-_]*={0,2}$/.test(header) || header.length % 4 === 1) return failure("invalid_base64");
    let jsonText: string;
    try {
      jsonText = Buffer.from(header, "base64url").toString("utf8");
    } catch {
      return failure("invalid_base64");
    }
    if (jsonText.length === 0) return failure("invalid_json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return failure("invalid_json");
    }
    if (!isRecord(parsed)) return failure("invalid_shape");
    if (parsed.v !== 1) return failure("unsupported_version");
    const rawAttempts: unknown = parsed.a === undefined ? [] : parsed.a;
    if (!Array.isArray(rawAttempts)) return failure("invalid_shape");
    if (rawAttempts.length > MAX_ENTRIES) return failure("too_many_entries");
    const attempts: AttemptSummaryEntry[] = [];
    for (const item of rawAttempts) {
      if (!isRecord(item)) return failure("invalid_shape");
      if (typeof item.p !== "string" || item.p.length > MAX_PROVIDER_CHARS) return failure("invalid_provider");
      if (typeof item.m !== "string" || item.m.length > MAX_MODEL_CHARS) return failure("invalid_model");
      if (typeof item.o !== "string" || item.o.length > MAX_OUTCOME_CHARS) return failure("invalid_outcome");
      if (item.s !== null && !(typeof item.s === "number" && Number.isInteger(item.s) && item.s >= 100 && item.s <= 599)) {
        return failure("invalid_status");
      }
      attempts.push({ provider: item.p, model: item.m, status: item.s, outcome: item.o });
    }
    if (parsed.t === undefined) {
      return { ok: true, version: 1, attempts, total: attempts.length, truncated: false };
    }
    if (typeof parsed.t !== "number" || !Number.isInteger(parsed.t) || parsed.t < 0) return failure("invalid_total");
    const total: number = parsed.t;
    if (total < attempts.length) return failure("invalid_total");
    return { ok: true, version: 1, attempts, total, truncated: total > attempts.length };
  } catch {
    return failure("invalid_shape");
  }
}

export function describeTerminal(terminal: string): string {
  switch (terminal) {
    case "complete":
      return "Completed";
    case "rate_limited":
      return "Rate limited";
    case "fallback_exhausted":
      return "Fallback exhausted";
    case "non_retryable":
      return "Non-retryable error";
    case "request_timeout":
      return "Request timed out";
    case "client_cancelled":
      return "Client cancelled";
    case "no_candidate":
      return "No candidate available";
    case "invalid_request":
      return "Invalid request";
    case "stream_committed":
      return "Stream committed";
    default:
      return "Unknown";
  }
}
