import type { IncomingMessage, ServerResponse } from "node:http";
import { catalogModelFreeStatus, isFreeExternalCatalogModel } from "./catalog.js";
import type { CatalogService } from "./catalog.js";
import type { ConfigStore } from "./config.js";
import type { ProviderRuntime } from "./types.js";

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const IMAGE_TIMEOUT_MS = 240_000;
const MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const ASPECT_RATIOS = new Set(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "2:1", "1:2"]);
const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const FORMATS = new Set(["png", "jpeg", "webp", "svg"]);

class ImageHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  if (response.destroyed || response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(bytes);
}

async function readJsonBody(request: IncomingMessage, maximum = MAX_REQUEST_BYTES): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximum) throw new ImageHttpError(413, "Image request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new ImageHttpError(413, "Image request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new ImageHttpError(400, "Image request body must be valid JSON");
  }
}

function validImage(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const svg = bytes.toString("utf8").trim();
  return /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) && !/<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|<!DOCTYPE|<!ENTITY/i.test(svg);
}

function safeUsage(value: unknown): object | null {
  const usage = object(value); if (!usage) return null;
  const safe: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) {
    if (typeof usage[key] === "number" && Number.isFinite(usage[key])) safe[key] = usage[key];
  }
  return Object.keys(safe).length ? safe : null;
}

async function responseBytes(response: Response, maximum: number, controller: AbortController): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new ImageHttpError(502, "Image provider response is too large");
  if (!response.body) throw new ImageHttpError(502, "Image provider returned an empty response");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > maximum) { controller.abort(); throw new ImageHttpError(502, "Image provider response is too large"); }
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export class AdminImageService {
  private active = false;

  constructor(private readonly providers: ProviderRuntime[], private readonly catalog: CatalogService, private readonly config: ConfigStore) {}

  capabilities(response: ServerResponse): void {
    const provider = this.providers.find((entry) => entry.id === "openrouter");
    if (!provider?.configured || !provider.apiKey) {
      sendJson(response, 200, { status: "unconfigured", models: [], formats: [...FORMATS], aspectRatios: [...ASPECT_RATIOS], qualities: [...QUALITIES], ephemeral: true });
      return;
    }
    const models = this.imageModels().map((model) => ({
      id: model.id,
      displayName: model.displayName ?? model.id,
      provider: "openrouter",
      free: catalogModelFreeStatus(model),
      pricing: model.pricing ?? null,
      pricingTiers: model.pricingTiers ?? null,
      contextTokens: model.contextTokens ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      inputModalities: model.inputModalities ?? null,
      outputModalities: model.outputModalities ?? null,
      capabilities: model.capabilities ?? { tools: null, vision: null, audio: null, reasoning: null, caching: null, webSearch: null },
      protocols: model.protocols,
      endpoints: model.endpoints ?? null,
      source: model.source,
      metadataSource: model.metadataSource ?? null,
      supportedParameters: model.supportedParameters ?? null,
      quality: { modelRatio: model.modelRatio, completionRatio: model.completionRatio }
    }));
    sendJson(response, 200, { status: models.length ? "available" : "unavailable", models, formats: [...FORMATS], aspectRatios: [...ASPECT_RATIOS], qualities: [...QUALITIES], ephemeral: true });
  }

  async generate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.active) return sendJson(response, 429, { error: "An image generation is already active" });
    try {
      const body = object(await readJsonBody(request));
      if (!body || Object.keys(body).some((key) => !["model", "prompt", "aspectRatio", "quality", "outputFormat"].includes(key))) throw new ImageHttpError(400, "Image request is invalid");
      if (typeof body.model !== "string" || !this.imageModels().some((model) => model.id === body.model)) throw new ImageHttpError(400, "Image model is unavailable or not enabled");
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 16_000) throw new ImageHttpError(400, "Image prompt must contain 1 to 16000 characters");
      if (body.aspectRatio !== undefined && (typeof body.aspectRatio !== "string" || !ASPECT_RATIOS.has(body.aspectRatio))) throw new ImageHttpError(400, "Image aspect ratio is invalid");
      if (body.quality !== undefined && (typeof body.quality !== "string" || !QUALITIES.has(body.quality))) throw new ImageHttpError(400, "Image quality is invalid");
      if (body.outputFormat !== undefined && (typeof body.outputFormat !== "string" || !FORMATS.has(body.outputFormat))) throw new ImageHttpError(400, "Image output format is invalid");
      const provider = this.providers.find((entry) => entry.id === "openrouter");
      if (!provider?.configured || !provider.apiKey) throw new ImageHttpError(503, "OpenRouter image generation is not configured");
      this.active = true;
      const controller = new AbortController();
      const disconnected = () => controller.abort(); request.once("aborted", disconnected); response.once("close", disconnected);
      const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS); timer.unref();
      try {
        const upstream = await fetch(`${provider.baseUrl}/images`, {
          method: "POST",
          headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ model: body.model.slice("openrouter:".length), prompt: body.prompt.trim(), n: 1, ...(body.aspectRatio ? { aspect_ratio: body.aspectRatio } : {}), ...(body.quality ? { quality: body.quality } : {}), ...(body.outputFormat ? { output_format: body.outputFormat } : {}) }),
          signal: controller.signal
        });
        if (!upstream.ok) throw new ImageHttpError(502, "Image provider rejected the request");
        if (!(upstream.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new ImageHttpError(502, "Image provider returned an invalid content type");
        const bytes = await responseBytes(upstream, MAX_RESPONSE_BYTES, controller);
        const payload = object(JSON.parse(bytes.toString("utf8"))); const data = payload?.data;
        if (!Array.isArray(data) || data.length !== 1) throw new ImageHttpError(502, "Image provider must return exactly one image");
        const images = data.map((entry) => {
          const item = object(entry); const encoded = item?.b64_json; const mime = item?.media_type;
          if (typeof encoded !== "string" || typeof mime !== "string" || !MIMES.has(mime) || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ImageHttpError(502, "Image provider returned invalid image data");
          const decoded = Buffer.from(encoded, "base64");
          if (!decoded.length || decoded.length > MAX_IMAGE_BYTES || decoded.toString("base64") !== encoded || !validImage(decoded, mime)) throw new ImageHttpError(502, "Image provider returned invalid image data");
          return { dataUrl: `data:${mime};base64,${encoded}`, mediaType: mime, bytes: decoded.length };
        });
        sendJson(response, 200, { images, usage: safeUsage(payload?.usage), ephemeral: true });
      } finally {
        clearTimeout(timer); request.off("aborted", disconnected); response.off("close", disconnected); this.active = false;
      }
    } catch (error) {
      const known = error instanceof ImageHttpError ? error : null;
      sendJson(response, known?.status ?? 502, { error: known?.message ?? "Image generation failed" });
    }
  }

  private imageModels() {
    const current = this.config.get();
    return this.catalog.getModels().filter((model) => model.providerId === "openrouter" && model.inputModalities?.includes("text") && model.outputModalities?.includes("image") && !current.disabledModels.includes(model.id) && (isFreeExternalCatalogModel(model) || current.enabledExternalModels.includes(model.id)));
  }
}
