import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRuntime } from "./types.js";

const MIB = 1024 * 1024;
const CAPABILITY_TTL_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const SPEECH_TIMEOUT_MS = 120_000;
const TRANSCRIPTION_TIMEOUT_MS = 300_000;
const MAX_DISCOVERY_BYTES = 4 * MIB;
const MAX_SPEECH_BYTES = 32 * MIB;
const MAX_TRANSCRIPTION_BODY_BYTES = 17 * MIB;
const MAX_TRANSCRIPTION_FILE_BYTES = 16 * MIB;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 2 * MIB;
const TRANSCRIPTION_EXTENSIONS = ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"] as const;

type CapabilityState = "available" | "unconfigured" | "error";
type AudioModel = {
  id: string;
  displayName: string;
  free: boolean;
  pricing: Record<string, string | number | null> | null;
  voices: string[];
  formats: string[];
};
type CapabilityResult = {
  speech: { provider: "openrouter"; status: CapabilityState; models: AudioModel[] };
  transcription: { provider: "local" | "requesty" | "local+requesty"; status: CapabilityState; models: AudioModel[]; formats: string[] };
};
export type LocalSttConfig = Readonly<{ baseUrl: string; model: string; apiKey: string }>;

class AudioHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  if (response.destroyed || response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readIncoming(request: IncomingMessage, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximum) throw new AudioHttpError(413, "Request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = request[Symbol.asyncIterator]();
  let abortHandler: (() => void) | undefined;
  const aborted = signal ? new Promise<never>((_, reject) => {
    abortHandler = () => reject(signal.reason ?? new Error("Audio request aborted"));
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  }) : null;
  try {
    while (true) {
      const item = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (item.done) break;
      const bytes = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
      size += bytes.length;
      if (size > maximum) throw new AudioHttpError(413, "Request body is too large");
      chunks.push(bytes);
    }
  } finally {
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    await iterator.return?.();
  }
  return Buffer.concat(chunks, size);
}

async function readFetchBody(response: Response, maximum: number, controller: AbortController): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    controller.abort();
    throw new AudioHttpError(502, "Audio provider response is too large");
  }
  if (!response.body) throw new AudioHttpError(502, "Audio provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) {
        controller.abort();
        throw new AudioHttpError(502, "Audio provider response is too large");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function requestController(request: IncomingMessage, response: ServerResponse, timeout: number): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const disconnected = () => controller.abort(new Error("Client disconnected"));
  request.once("aborted", disconnected);
  response.once("close", disconnected);
  const timer = setTimeout(() => controller.abort(new Error("Audio request timed out")), timeout);
  timer.unref();
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
    }
  };
}

function discoveryController(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  timer.unref();
  return { controller, cleanup: () => clearTimeout(timer) };
}

function pricing(value: unknown): Record<string, string | number | null> | null {
  if (!plainObject(value)) return null;
  const safe: Record<string, string | number | null> = {};
  for (const [key, amount] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) continue;
    if (amount === null || (typeof amount === "number" && Number.isFinite(amount))) safe[key] = amount;
    else if (typeof amount === "string" && amount.length <= 128 && amount.trim() && Number.isFinite(Number(amount))) safe[key] = amount;
  }
  return Object.keys(safe).length ? safe : null;
}

function isFree(id: string, modelPricing: Record<string, string | number | null> | null): boolean {
  const amounts = Object.values(modelPricing ?? {}).filter((value): value is string | number => value !== null);
  if (amounts.length) return amounts.every((value) => Number(value) === 0);
  return id.toLowerCase().endsWith(":free");
}

function strings(value: unknown, maximum = 100): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 128).slice(0, maximum);
}

function modelEntries(payload: unknown): unknown[] {
  if (!plainObject(payload)) throw new Error("Invalid discovery response");
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
  if (!entries || entries.length > 1_000) throw new Error("Invalid discovery response");
  return entries;
}

function capabilityModels(payload: unknown, provider: "openrouter" | "requesty" | "local", speech: boolean): AudioModel[] {
  const output: AudioModel[] = [];
  for (const entry of modelEntries(payload)) {
    if (!plainObject(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 512) continue;
    const id = entry.id.startsWith(`${provider}:`) ? entry.id : `${provider}:${entry.id}`;
    const modelPricing = pricing(entry.pricing);
    const nested = plainObject(entry.top_provider) ? entry.top_provider : {};
    const voices = speech ? strings(entry.supported_voices ?? entry.voices ?? entry.voice_options ?? nested.supported_voices) : [];
    output.push({
      id,
      displayName: typeof entry.name === "string" && entry.name.length <= 512 ? entry.name : entry.id,
      free: provider === "local" || isFree(entry.id, modelPricing),
      pricing: modelPricing,
      voices,
      formats: speech ? ["mp3", "pcm"] : [...TRANSCRIPTION_EXTENSIONS]
    });
  }
  return output;
}

const USAGE_KEYS = new Set([
  "type", "seconds", "duration", "tokens", "characters", "minutes", "input_tokens", "output_tokens", "total_tokens",
  "prompt_tokens", "completion_tokens", "audio_tokens", "text_tokens", "cached_tokens", "input_token_details", "output_token_details"
]);

function sanitizedUsage(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 4_096);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizedUsage(entry, depth + 1));
  if (!plainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).slice(0, 100)
    .filter(([key]) => USAGE_KEYS.has(key))
    .map(([key, entry]) => [key, sanitizedUsage(entry, depth + 1)]));
}

export class AdminAudioService {
  private active = 0;
  private cached: { expiresAt: number; value: CapabilityResult } | null = null;
  private discoveryGeneration = 0;
  private pendingDiscovery: { generation: number; promise: Promise<CapabilityResult> } | null = null;

  private readonly localStt: LocalSttConfig;

  constructor(private readonly providers: ProviderRuntime[], localStt: LocalSttConfig) {
    this.localStt = Object.freeze({ ...localStt });
  }

  invalidate(providerId?: string): void {
    if (!providerId || providerId === "openrouter" || providerId === "requesty") {
      this.discoveryGeneration += 1;
      this.cached = null;
      this.pendingDiscovery = null;
    }
  }

  async capabilities(response: ServerResponse, refresh: boolean): Promise<void> {
    try {
      sendJson(response, 200, await this.discover(refresh));
    } catch {
      sendJson(response, 500, { error: "Audio capability discovery failed" });
    }
  }

  async speech(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let release: (() => void) | undefined;
    const lifecycle = requestController(request, response, SPEECH_TIMEOUT_MS);
    try {
      let input: unknown;
      try {
        input = JSON.parse((await readIncoming(request, MIB, lifecycle.controller.signal)).toString("utf8"));
      } catch (error) {
        if (error instanceof AudioHttpError) throw error;
        throw new AudioHttpError(400, "Speech body must be valid JSON");
      }
      const body = this.speechBody(input);
      release = this.acquire();
      const provider = this.provider("openrouter");
      if (!provider?.configured || !provider.apiKey) throw new AudioHttpError(503, "Speech provider is not configured");
      const capabilities = await this.discover(false);
      const selectedModel = capabilities.speech.models.find((model) => model.id === `openrouter:${String(body.model)}`);
      if (!selectedModel) throw new AudioHttpError(400, "Speech model is not in the current OpenRouter speech catalog");
      if (!selectedModel.free) throw new AudioHttpError(403, "Only catalog-confirmed free speech models are enabled in this initial release");
      if (typeof body.voice === "string" && selectedModel.voices.length && !selectedModel.voices.includes(body.voice)) {
        throw new AudioHttpError(400, "Speech voice is not advertised for the selected model");
      }
      if (lifecycle.controller.signal.aborted) throw new Error("Audio request aborted");
      const upstream = await fetch(`${provider.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${provider.apiKey}`, accept: "audio/*, application/octet-stream", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: lifecycle.controller.signal
      });
      if (!upstream.ok) throw new AudioHttpError(502, "Speech provider rejected the request");
      const contentType = (upstream.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (!/^audio\/[a-z0-9!#$&^_.+-]+$/.test(contentType) && contentType !== "application/octet-stream") {
        throw new AudioHttpError(502, "Speech provider returned an invalid content type");
      }
      const bytes = await readFetchBody(upstream, MAX_SPEECH_BYTES, lifecycle.controller);
      const responseFormat = body.response_format ?? "pcm";
      if (!bytes.length) throw new AudioHttpError(502, "Speech provider returned an empty response");
      if (responseFormat === "mp3") {
        if (contentType !== "audio/mpeg" && contentType !== "audio/mp3" && contentType !== "application/octet-stream") {
          throw new AudioHttpError(502, "Speech provider returned audio in the wrong format");
        }
        const id3 = bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3";
        const frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
        if (bytes.length < 128 || (!id3 && !frame)) throw new AudioHttpError(502, "Speech provider returned invalid MP3 audio");
      } else {
        if (contentType !== "audio/pcm" && contentType !== "audio/l16" && contentType !== "application/octet-stream") {
          throw new AudioHttpError(502, "Speech provider returned audio in the wrong format");
        }
        if (bytes.length % 2 !== 0) throw new AudioHttpError(502, "Speech provider returned invalid PCM audio");
      }
      if (response.destroyed) return;
      const generationId = upstream.headers.get("x-generation-id");
      response.writeHead(200, {
        "content-type": contentType,
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(generationId && /^[\x20-\x7e]{1,256}$/.test(generationId) ? { "x-generation-id": generationId } : {})
      });
      response.end(bytes);
    } catch (error) {
      this.failure(response, error, lifecycle.controller.signal.aborted);
    } finally {
      lifecycle.cleanup();
      release?.();
    }
  }

  async transcriptions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let release: (() => void) | undefined;
    const lifecycle = requestController(request, response, TRANSCRIPTION_TIMEOUT_MS);
    try {
      release = this.acquire();
      const contentType = request.headers["content-type"] ?? "";
      const bytes = await readIncoming(request, MAX_TRANSCRIPTION_BODY_BYTES, lifecycle.controller.signal);
      let form: FormData;
      try {
        form = await new Request("http://localhost/", { method: "POST", headers: { "content-type": contentType }, body: Uint8Array.from(bytes).buffer }).formData();
      } catch {
        throw new AudioHttpError(400, "Transcription body must be valid multipart form data");
      }
      const fields = new Map<string, FormDataEntryValue[]>();
      for (const [key, value] of form.entries()) {
        if (!fields.has(key)) fields.set(key, []);
        fields.get(key)!.push(value);
      }
      for (const key of fields.keys()) if (key !== "file" && key !== "model" && key !== "language") throw new AudioHttpError(400, "Unknown transcription field");
      if (fields.get("file")?.length !== 1 || fields.get("model")?.length !== 1 || (fields.get("language")?.length ?? 0) > 1) throw new AudioHttpError(400, "Transcription fields must not be missing or repeated");
      const file = fields.get("file")![0]!;
      const model = fields.get("model")![0]!;
      const language = fields.get("language")?.[0];
      if (typeof file === "string" || typeof model !== "string" || (language !== undefined && typeof language !== "string")) throw new AudioHttpError(400, "Transcription fields have invalid types");
      const source = model.startsWith("local:") ? "local" : model.startsWith("requesty:") ? "requesty" : null;
      const prefixLength = source === "local" ? 6 : 9;
      if (!source || model.length <= prefixLength || model.length > 512) throw new AudioHttpError(400, "Transcription model must start with local: or requesty:");
      if (!file.size) throw new AudioHttpError(400, "Transcription file is empty");
      if (file.size > MAX_TRANSCRIPTION_FILE_BYTES) throw new AudioHttpError(413, "Transcription file is too large");
      if (!file.name || file.name.length > 255) throw new AudioHttpError(400, "Transcription filename is invalid");
      const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
      if (!extension || !(TRANSCRIPTION_EXTENSIONS as readonly string[]).includes(extension)) throw new AudioHttpError(400, "Transcription file type is not supported");
      if (language !== undefined && !/^[a-z]{2}$/.test(language)) throw new AudioHttpError(400, "Language must be two lowercase letters");
      const capabilities = await this.discover(false);
      if (!capabilities.transcription.models.some((entry) => entry.id === model)) {
        throw new AudioHttpError(400, "Transcription model is not approved in the current catalog");
      }
      const provider = source === "requesty" ? this.provider("requesty") : undefined;
      if (source === "requesty" && (!provider?.configured || !provider.apiKey)) throw new AudioHttpError(503, "Transcription provider is not configured");
      if (source === "local" && !this.localStt.baseUrl) throw new AudioHttpError(503, "Local transcription provider is not configured");
      const upstreamForm = new FormData();
      upstreamForm.append("file", file, `audio.${extension}`);
      upstreamForm.append("model", model.slice(prefixLength));
      if (language !== undefined) upstreamForm.append("language", language);
      if (source === "local") upstreamForm.append("prompt", "RouteTok");
      if (lifecycle.controller.signal.aborted) throw new Error("Audio request aborted");
      const destination = source === "local" ? this.localStt.baseUrl : provider!.baseUrl;
      const credential = source === "local" ? this.localStt.apiKey : provider!.apiKey;
      const upstream = await fetch(`${destination}/audio/transcriptions`, {
        method: "POST",
        headers: { accept: "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        body: upstreamForm,
        signal: lifecycle.controller.signal
      });
      if (!upstream.ok) throw new AudioHttpError(502, "Transcription provider rejected the request");
      const upstreamType = (upstream.headers.get("content-type") ?? "").toLowerCase();
      if (!upstreamType.startsWith("application/json")) throw new AudioHttpError(502, "Transcription provider returned an invalid content type");
      const responseBytes = await readFetchBody(upstream, MAX_TRANSCRIPTION_RESPONSE_BYTES, lifecycle.controller);
      let payload: unknown;
      try { payload = JSON.parse(responseBytes.toString("utf8")); } catch { throw new AudioHttpError(502, "Transcription provider returned invalid JSON"); }
      if (!plainObject(payload) || typeof payload.text !== "string" || payload.text.length > 50_000) throw new AudioHttpError(502, "Transcription provider returned an invalid response");
      sendJson(response, 200, { text: payload.text, usage: sanitizedUsage(payload.usage ?? null) });
    } catch (error) {
      this.failure(response, error, lifecycle.controller.signal.aborted);
    } finally {
      lifecycle.cleanup();
      release?.();
    }
  }

  private speechBody(input: unknown): Record<string, unknown> {
    if (!plainObject(input)) throw new AudioHttpError(400, "Speech body must be an object");
    const allowed = new Set(["model", "input", "voice", "responseFormat", "speed"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new AudioHttpError(400, "Unknown speech field");
    if (typeof input.model !== "string" || !input.model.startsWith("openrouter:") || input.model.length <= 11 || input.model.length > 512) throw new AudioHttpError(400, "Speech model must start with openrouter:");
    if (typeof input.input !== "string" || !input.input.length || input.input.length > 4_096) throw new AudioHttpError(400, "Speech input must contain 1 to 4096 characters");
    if (input.voice !== undefined && (typeof input.voice !== "string" || !input.voice || input.voice.length > 128)) throw new AudioHttpError(400, "Speech voice is invalid");
    if (input.responseFormat !== undefined && input.responseFormat !== "mp3" && input.responseFormat !== "pcm") throw new AudioHttpError(400, "Speech responseFormat must be mp3 or pcm");
    if (input.speed !== undefined && (typeof input.speed !== "number" || !Number.isFinite(input.speed) || input.speed < 0.25 || input.speed > 4)) throw new AudioHttpError(400, "Speech speed must be between 0.25 and 4");
    return {
      model: input.model.slice(11),
      input: input.input,
      ...(input.voice !== undefined ? { voice: input.voice } : {}),
      ...(input.responseFormat !== undefined ? { response_format: input.responseFormat } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {})
    };
  }

  private acquire(): () => void {
    if (this.active >= 2) throw new AudioHttpError(429, "Too many active audio requests");
    this.active += 1;
    return () => { this.active -= 1; };
  }

  private failure(response: ServerResponse, error: unknown, aborted: boolean): void {
    if (response.destroyed) return;
    const known = error instanceof AudioHttpError ? error : null;
    const status = known?.status ?? (aborted ? 504 : 502);
    if (status === 429) response.setHeader("retry-after", "1");
    sendJson(response, status, { error: known?.message ?? (aborted ? "Audio request timed out" : "Audio provider request failed") });
  }

  private provider(id: "openrouter" | "requesty"): ProviderRuntime | undefined {
    return this.providers.find((provider) => provider.id === id);
  }

  private async discover(refresh: boolean): Promise<CapabilityResult> {
    if (!refresh && this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const generation = this.discoveryGeneration;
    if (this.pendingDiscovery?.generation === generation) return this.pendingDiscovery.promise;
    const promise = Promise.all([this.discoverProvider("openrouter"), this.discoverLocal(), this.discoverProvider("requesty")]).then(([speech, local, requesty]) => {
      const localModels = local.models.sort((left, right) => Number(right.id === `local:${this.localStt.model}`) - Number(left.id === `local:${this.localStt.model}`));
      const transcriptionModels = [...localModels, ...requesty.models];
      const sources = [localModels.length ? "local" : null, requesty.models.length ? "requesty" : null].filter(Boolean) as Array<"local" | "requesty">;
      const transcriptionStatus: CapabilityState = transcriptionModels.length
        ? "available"
        : local.status === "unconfigured" && requesty.status === "unconfigured" ? "unconfigured" : "error";
      const value: CapabilityResult = {
        speech: { provider: "openrouter", status: speech.status, models: speech.models.filter((model) => model.free) },
        transcription: {
          provider: sources.length === 2 ? "local+requesty" : sources[0] ?? (this.localStt.baseUrl ? "local" : "requesty"),
          status: transcriptionStatus,
          models: transcriptionModels,
          formats: [...TRANSCRIPTION_EXTENSIONS]
        }
      };
      if (generation === this.discoveryGeneration) this.cached = { expiresAt: Date.now() + CAPABILITY_TTL_MS, value };
      return value;
    }).finally(() => {
      if (this.pendingDiscovery?.promise === promise) this.pendingDiscovery = null;
    });
    this.pendingDiscovery = { generation, promise };
    return promise;
  }

  private async discoverProvider(id: "openrouter" | "requesty"): Promise<{ status: CapabilityState; models: AudioModel[] }> {
    const provider = this.provider(id);
    if (!provider?.configured || !provider.apiKey) return { status: "unconfigured", models: [] };
    const lifecycle = discoveryController();
    try {
      const endpoint = id === "openrouter" ? "/models?output_modalities=speech" : "/models/transcription";
      const response = await fetch(`${provider.baseUrl}${endpoint}`, {
        headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json" },
        signal: lifecycle.controller.signal
      });
      if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return { status: "error", models: [] };
      const bytes = await readFetchBody(response, MAX_DISCOVERY_BYTES, lifecycle.controller);
      return { status: "available", models: capabilityModels(JSON.parse(bytes.toString("utf8")), id, id === "openrouter") };
    } catch {
      return { status: "error", models: [] };
    } finally {
      lifecycle.cleanup();
    }
  }

  private async discoverLocal(): Promise<{ status: CapabilityState; models: AudioModel[] }> {
    if (!this.localStt.baseUrl) return { status: "unconfigured", models: [] };
    const lifecycle = discoveryController();
    try {
      const response = await fetch(`${this.localStt.baseUrl}/models`, {
        headers: { accept: "application/json", ...(this.localStt.apiKey ? { authorization: `Bearer ${this.localStt.apiKey}` } : {}) },
        signal: lifecycle.controller.signal
      });
      if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return { status: "error", models: [] };
      const bytes = await readFetchBody(response, MAX_DISCOVERY_BYTES, lifecycle.controller);
      return { status: "available", models: capabilityModels(JSON.parse(bytes.toString("utf8")), "local", false) };
    } catch {
      return { status: "error", models: [] };
    } finally {
      lifecycle.cleanup();
    }
  }
}
