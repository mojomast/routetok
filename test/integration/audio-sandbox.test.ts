import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv, stopChild } from "../support/process.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(output)), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("RouteTok listening")) { clearTimeout(timer); resolve(); }
    });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.once("exit", () => reject(new Error(output)));
  });
}

async function incomingBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("bounded dashboard audio APIs discover and proxy without retaining content", async () => {
  const speechBytes = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(252, 0x55)]);
  const speechRequests: Array<{ authorization: string | undefined; dashboard: string | undefined; body: Record<string, unknown> }> = [];
  let transcriptionRequest: { authorization: string | undefined; model: string; language: string; name: string; bytes: Buffer } | null = null;
  let localTranscriptionRequest: { authorization: string | undefined; model: string; language: string; prompt: string; name: string; bytes: Buffer } | null = null;
  let imageRequest: { authorization: string | undefined; body: Record<string, unknown> } | null = null;
  let speechDiscoveryCount = 0;
  let paidOnlySpeech = false;
  const upstream = createServer(async (request, response) => {
    if (request.url === "/openrouter/v1/models?output_modalities=all") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        id: "vendor/image-model", name: "Image Model", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["max_tokens"]
      }] }));
      return;
    }
    if (request.url === "/opencode/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
      return;
    }
    if (request.url === "/opencode/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "managed-key-internal-ok" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (request.url === "/requesty/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === "/openrouter/v1/models?output_modalities=speech") {
      speechDiscoveryCount += 1;
      assert.equal(request.headers.authorization, "Bearer effective-openrouter");
      const speechModels = [
        { id: "black-forest-labs/flux-speech:free", name: "Flux Speech", context_length: 65536, top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ["text"], output_modalities: ["audio"] }, supported_parameters: ["voice", "speed"], pricing: { audio: "0", currency: "usd", unit: "per_audio_token", api_key: "123456" }, supported_voices: ["nova", "alloy"], secret: "not-for-clients" },
        { id: "fish-audio/s1-mini:free", name: "Fish Audio", pricing: { audio: "0.000" }, voices: ["fish"] },
        { id: "vendor/empty-voices:free", name: "Empty Voices", pricing: { audio: "0" }, supported_voices: [] },
        { id: "vendor/partial-price:free", name: "Partial Price", pricing: { audio: null, prompt: "0" } },
        { id: "vendor/paid-speech", name: "Paid Speech", pricing: { audio: "0.01" }, supported_voices: ["paid"] }
      ];
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: paidOnlySpeech ? speechModels.filter((model) => model.id === "vendor/paid-speech") : speechModels, base_url: "http://private", token: "upstream-secret" }));
      return;
    }
    if (request.url === "/requesty/v1/models/transcription") {
      assert.equal(request.headers.authorization, "Bearer effective-requesty");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        { id: "vendor/whisper", name: "Whisper", context_window: 32768, input_modalities: ["audio"], output_modalities: ["text"], supported_parameters: ["language"], pricing: { audio: "0.001" }, api_key: "hidden" }
      ], internal: "hidden" }));
      return;
    }
    if (request.url === "/local/v1/models") {
      assert.equal(request.headers.authorization, "Bearer local-stt-secret");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        { id: "other/local-model", name: "Other local model", secret: "hidden" },
        { id: "Systran/faster-whisper-small", name: "Local Whisper Small", api_key: "hidden" }
      ], base_url: "http://private-local", token: "upstream-local-secret" }));
      return;
    }
    if (request.url === "/openrouter/v1/audio/speech") {
      const payload = JSON.parse((await incomingBytes(request)).toString("utf8")) as Record<string, unknown>;
      speechRequests.push({
        authorization: request.headers.authorization,
        dashboard: request.headers["x-dashboard-token"] as string | undefined,
        body: payload
      });
      const pcm = Buffer.from([1, 0, 2, 0]);
      response.writeHead(200, { "content-type": payload.response_format === "mp3" ? "audio/mpeg; charset=binary" : "audio/pcm", "x-generation-id": "gen-safe", "x-secret": "hidden" }).end(payload.response_format === "mp3" ? speechBytes : pcm);
      return;
    }
    if (request.url === "/openrouter/v1/images") {
      imageRequest = { authorization: request.headers.authorization, body: JSON.parse((await incomingBytes(request)).toString("utf8")) as Record<string, unknown> };
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: png.toString("base64"), media_type: "image/png" }], usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12, cost: 0.02, secret: "hidden" } }));
      return;
    }
    if (request.url === "/requesty/v1/audio/transcriptions") {
      assert.match(request.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
      const body = Uint8Array.from(await incomingBytes(request)).buffer;
      const form = await new Request("http://localhost/", { method: "POST", headers: { "content-type": request.headers["content-type"]! }, body }).formData();
      const file = form.get("file");
      assert(file && typeof file !== "string");
      transcriptionRequest = {
        authorization: request.headers.authorization,
        model: String(form.get("model")),
        language: String(form.get("language")),
        name: file.name,
        bytes: Buffer.from(await file.arrayBuffer())
      };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        text: "bounded transcript", usage: { seconds: 1.25, tokens: 7 }, provider_secret: "hidden", segments: [{ raw: "not returned" }]
      }));
      return;
    }
    if (request.url === "/local/v1/audio/transcriptions") {
      assert.match(request.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
      const body = Uint8Array.from(await incomingBytes(request)).buffer;
      const form = await new Request("http://localhost/", { method: "POST", headers: { "content-type": request.headers["content-type"]! }, body }).formData();
      const file = form.get("file");
      assert(file && typeof file !== "string");
      localTranscriptionRequest = {
        authorization: request.headers.authorization,
        model: String(form.get("model")),
        language: String(form.get("language")),
        prompt: String(form.get("prompt")),
        name: file.name,
        bytes: Buffer.from(await file.arrayBuffer())
      };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        text: "local bounded transcript", usage: { seconds: 0.75, tokens: 4, secret: "hidden" }, provider_secret: "hidden", segments: [{ raw: "not returned" }]
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const root = `http://127.0.0.1:${upstreamAddress.port}`;
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-audio-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      DASHBOARD_TOKEN: "dashboard-secret",
      OPENROUTER_API_KEY: "effective-openrouter",
      OPENROUTER_BASE_URL: `${root}/openrouter/v1`,
      OPENCODE_ZEN_BASE_URL: `${root}/opencode`,
      REQUESTY_API_KEY: "effective-requesty",
      REQUESTY_BASE_URL: `${root}/requesty/v1`,
      LOCAL_STT_BASE_URL: `${root}/local/v1///`,
      LOCAL_STT_API_KEY: "local-stt-secret"
    })
  });
  const base = `http://127.0.0.1:${port}`;
  const dashboardHeaders = { "x-dashboard-token": "dashboard-secret" };
  try {
    await ready(child);
    assert.equal((await fetch(`${base}/admin/api/audio/capabilities`)).status, 401);
    assert.equal((await fetch(`${base}/admin/api/sandbox/catalog`)).status, 401);
    assert.equal((await fetch(`${base}/admin/api/images/capabilities`)).status, 401);
    assert.equal((await fetch(`${base}/admin/api/client-keys`)).status, 401);

    const initialClientKeys = await fetch(`${base}/admin/api/client-keys`, { headers: dashboardHeaders }).then((response) => response.json()) as { keys: unknown[]; environmentKeyConfigured: boolean };
    assert.deepEqual(initialClientKeys, { keys: [], environmentKeyConfigured: false });
    const createClientKey = await fetch(`${base}/admin/api/client-keys`, { method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: JSON.stringify({ label: "Integration client" }) });
    assert.equal(createClientKey.status, 201);
    const createdClientKey = await createClientKey.json() as { key: { id: string; label: string; createdAt: string }; secret: string };
    assert.equal(createdClientKey.key.label, "Integration client");
    assert.match(createdClientKey.secret, /^rtk_[A-Za-z0-9_-]{43}$/);
    const listedClientKeys = await fetch(`${base}/admin/api/client-keys`, { headers: dashboardHeaders }).then((response) => response.json()) as { keys: Array<{ id: string; label: string }>; environmentKeyConfigured: boolean };
    assert.deepEqual(listedClientKeys.keys.map(({ id, label }) => ({ id, label })), [{ id: createdClientKey.key.id, label: "Integration client" }]);
    assert.doesNotMatch(JSON.stringify(listedClientKeys), new RegExp(createdClientKey.secret));
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${createdClientKey.secret}` } })).status, 200);
    const managedKeySandbox = await fetch(`${base}/admin/api/sandbox`, {
      method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ id: "managed-key", model: "opencode:big-pickle", messages: [{ role: "user", content: "exercise internal self-auth" }] }] })
    });
    assert.equal(managedKeySandbox.status, 200);
    assert.equal((await managedKeySandbox.json() as { results: Array<{ content: string }> }).results[0]?.content, "managed-key-internal-ok");
    const revokeClientKey = await fetch(`${base}/admin/api/client-keys/${createdClientKey.key.id}`, { method: "DELETE", headers: dashboardHeaders });
    assert.equal(revokeClientKey.status, 200);
    assert.equal((await fetch(`${base}/v1/models`)).status, 200);

    const sandboxCatalogResponse = await fetch(`${base}/admin/api/sandbox/catalog`, { headers: dashboardHeaders });
    assert.equal(sandboxCatalogResponse.status, 200);
    const sandboxCatalog = await sandboxCatalogResponse.json() as { maxLanes: number; supportedPurposes: string[]; models: Array<{ id: string; provider: string; displayName: string; pricing: { input: number | null; output: number | null } }> };
    assert.equal(sandboxCatalog.maxLanes, 4);
    assert.deepEqual(sandboxCatalog.supportedPurposes, ["chat", "design", "diagnose"]);
    assert(sandboxCatalog.models.length > 0);
    assert(sandboxCatalog.models.every((model) => model.id && model.provider && model.displayName && model.pricing && "input" in model.pricing && "output" in model.pricing));
    assert.doesNotMatch(JSON.stringify(sandboxCatalog), /api.?key|credential|base.?url|effective-openrouter|secret|private/i);
    assert(!sandboxCatalog.models.some((model) => model.id.includes("image-model")), "image-only models must not enter text comparisons");

    const initialImageCapabilities = await fetch(`${base}/admin/api/images/capabilities`, { headers: dashboardHeaders }).then((response) => response.json()) as { models: unknown[] };
    assert.equal(initialImageCapabilities.models.length, 0, "paid or unknown image models require explicit enablement");
    const enabledImageConfig = await fetch(`${base}/admin/api/config`, { method: "PATCH", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: JSON.stringify({ enabledExternalModels: ["openrouter:vendor/image-model"] }) });
    assert.equal(enabledImageConfig.status, 200);
    const imageCapabilities = await fetch(`${base}/admin/api/images/capabilities`, { headers: dashboardHeaders }).then((response) => response.json()) as { ephemeral: boolean; models: Array<{ id: string }> };
    assert.equal(imageCapabilities.ephemeral, true);
    assert.deepEqual(imageCapabilities.models.map((model) => model.id), ["openrouter:vendor/image-model"]);

    const capabilityResponse = await fetch(`${base}/admin/api/audio/capabilities`, { headers: dashboardHeaders });
    assert.equal(capabilityResponse.status, 200);
    const capabilities = await capabilityResponse.json() as {
      speech: { status: string; models: Array<{ id: string; displayName: string; free: boolean; freeStatus: boolean | null; voices: string[]; formats: string[]; [key: string]: unknown }> };
      transcription: { provider: string; status: string; models: Array<{ id: string }> };
    };
    assert.equal(capabilities.speech.status, "available");
    assert.equal(capabilities.transcription.status, "available");
    assert.deepEqual(capabilities.speech.models[0], {
      id: "openrouter:black-forest-labs/flux-speech:free", displayName: "Flux Speech", free: true, freeStatus: true,
      provider: "openrouter", upstreamId: "black-forest-labs/flux-speech:free", metadataSource: "provider",
      pricing: { audio: "0" }, pricingCurrency: "USD", pricingUnit: "per_audio_token",
      contextTokens: 65536, maxOutputTokens: 4096, inputModalities: ["text"], outputModalities: ["audio"],
      supportedParameters: ["voice", "speed"], capabilities: { tools: false, vision: false, audio: true, reasoning: false },
      voices: ["nova", "alloy"], voicesKnown: true, formats: ["mp3", "pcm"], formatsSource: "routetok"
    });
    assert(capabilities.speech.models.some((model) => model.id.includes("fish-audio") && model.free));
    assert(!capabilities.speech.models.some((model) => model.id.includes("partial-price")), "partially unknown pricing must not be advertised as free");
    assert(!capabilities.speech.models.some((model) => model.id.includes("paid-speech")), "initial release must advertise only free TTS models");
    assert.equal(capabilities.transcription.provider, "local+requesty");
    assert.deepEqual(capabilities.transcription.models.map((model) => model.id), [
      "local:Systran/faster-whisper-small", "local:other/local-model", "requesty:vendor/whisper"
    ]);
    assert.doesNotMatch(JSON.stringify(capabilities), /secret|base_url|api_key|private/i);
    await fetch(`${base}/admin/api/audio/capabilities`, { headers: dashboardHeaders });
    assert.equal(speechDiscoveryCount, 1);
    paidOnlySpeech = true;
    const paidOnlyCapabilities = await fetch(`${base}/admin/api/audio/capabilities?refresh=true`, { headers: dashboardHeaders }).then((response) => response.json()) as { speech: { status: string; models: unknown[] } };
    assert.equal(speechDiscoveryCount, 2);
    assert.equal(paidOnlyCapabilities.speech.status, "unavailable");
    assert.deepEqual(paidOnlyCapabilities.speech.models, []);
    paidOnlySpeech = false;
    await fetch(`${base}/admin/api/audio/capabilities?refresh=true`, { headers: dashboardHeaders });
    assert.equal(speechDiscoveryCount, 3);

    const unsupportedVoice = await fetch(`${base}/admin/api/audio/speech`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter:vendor/empty-voices:free", input: "voice check", voice: "not-advertised", responseFormat: "mp3" })
    });
    assert.equal(unsupportedVoice.status, 400);
    assert.equal(speechRequests.length, 0);

    const beforeStatus = await fetch(`${base}/admin/api/status`, { headers: dashboardHeaders }).then((response) => response.json()) as { metrics: { totals: { requests: number }; recent: unknown[] } };
    const beforeHistory = await fetch(`${base}/admin/api/history`, { headers: dashboardHeaders }).then((response) => response.json()) as { samples: unknown[]; retained: number };
    const generatedImage = await fetch(`${base}/admin/api/images/generations`, { method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: JSON.stringify({ model: "openrouter:vendor/image-model", prompt: "A bounded test image", aspectRatio: "1:1", quality: "low", outputFormat: "png" }) });
    assert.equal(generatedImage.status, 200);
    const generatedPayload = await generatedImage.json() as { images: Array<{ dataUrl: string; mediaType: string; bytes: number }>; usage: { cost: number }; ephemeral: boolean };
    assert.equal(generatedPayload.ephemeral, true);
    assert.equal(generatedPayload.images[0]?.mediaType, "image/png");
    assert.match(generatedPayload.images[0]?.dataUrl ?? "", /^data:image\/png;base64,/);
    assert.equal(generatedPayload.usage.cost, 0.02);
    assert.deepEqual(imageRequest, { authorization: "Bearer effective-openrouter", body: { model: "vendor/image-model", prompt: "A bounded test image", n: 1, aspect_ratio: "1:1", quality: "low", output_format: "png" } });
    const speech = await fetch(`${base}/admin/api/audio/speech`, {
      method: "POST",
      headers: { authorization: "Bearer dashboard-secret", "content-type": "application/json", "x-dashboard-token": "caller-value" },
      body: JSON.stringify({ model: "openrouter:black-forest-labs/flux-speech:free", input: "hello", voice: "nova", responseFormat: "mp3", speed: 1.5 })
    });
    assert.equal(speech.status, 200);
    assert.equal(speech.headers.get("content-type"), "audio/mpeg");
    assert.equal(speech.headers.get("x-generation-id"), "gen-safe");
    assert.equal(speech.headers.get("x-secret"), null);
    assert.equal(speech.headers.get("cache-control"), "no-store");
    assert.equal(speech.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await speech.arrayBuffer()), speechBytes);
    assert.deepEqual(speechRequests[0], {
      authorization: "Bearer effective-openrouter", dashboard: undefined,
      body: { model: "black-forest-labs/flux-speech:free", input: "hello", voice: "nova", response_format: "mp3", speed: 1.5 }
    });

    const defaultSpeech = await fetch(`${base}/admin/api/audio/speech`, {
      method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter:black-forest-labs/flux-speech:free", input: "default format" })
    });
    assert.equal(defaultSpeech.status, 200);
    assert.equal(defaultSpeech.headers.get("content-type"), "audio/pcm");
    assert.deepEqual(Buffer.from(await defaultSpeech.arrayBuffer()), Buffer.from([1, 0, 2, 0]));
    assert.deepEqual(speechRequests[1]?.body, { model: "black-forest-labs/flux-speech:free", input: "default format", response_format: "pcm" });

    const malformedImage = await fetch(`${base}/admin/api/images/generations`, {
      method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: "{not-json"
    });
    assert.equal(malformedImage.status, 400);
    const oversizedImage = await fetch(`${base}/admin/api/images/generations`, {
      method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(1024 * 1024) })
    });
    assert.equal(oversizedImage.status, 413);

    const audioFile = Buffer.from([9, 8, 0, 7, 6]);
    const localTranscriptionForm = new FormData();
    localTranscriptionForm.append("file", new Blob([audioFile], { type: "audio/wav" }), "private-name.wav");
    localTranscriptionForm.append("model", "local:Systran/faster-whisper-small");
    localTranscriptionForm.append("language", "en");
    const localTranscription = await fetch(`${base}/admin/api/audio/transcriptions`, {
      method: "POST", headers: { ...dashboardHeaders, authorization: "Bearer caller-credential" }, body: localTranscriptionForm
    });
    assert.equal(localTranscription.status, 200);
    assert.deepEqual(await localTranscription.json(), { text: "local bounded transcript", usage: { seconds: 0.75, tokens: 4 } });
    assert.deepEqual(localTranscriptionRequest, {
      authorization: "Bearer local-stt-secret", model: "Systran/faster-whisper-small", language: "en", prompt: "RouteTok", name: "audio.wav", bytes: audioFile
    });

    const transcriptionForm = new FormData();
    transcriptionForm.append("file", new Blob([audioFile], { type: "audio/wav" }), "sample.wav");
    transcriptionForm.append("model", "requesty:vendor/whisper");
    transcriptionForm.append("language", "en");
    const transcription = await fetch(`${base}/admin/api/audio/transcriptions`, {
      method: "POST", headers: { ...dashboardHeaders, authorization: "Bearer caller-credential" }, body: transcriptionForm
    });
    assert.equal(transcription.status, 200);
    assert.deepEqual(await transcription.json(), { text: "bounded transcript", usage: { seconds: 1.25, tokens: 7 } });
    assert.deepEqual(transcriptionRequest, {
      authorization: "Bearer effective-requesty", model: "vendor/whisper", language: "en", name: "audio.wav", bytes: audioFile
    });

    const invalidSpeech = async (body: object) => fetch(`${base}/admin/api/audio/speech`, {
      method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: JSON.stringify(body)
    });
    assert.equal((await invalidSpeech({ model: "vendor/voice", input: "hello" })).status, 400);
    assert.equal((await invalidSpeech({ model: "openrouter:voice", input: "hello", apiKey: "caller" })).status, 400);
    assert.equal((await invalidSpeech({ model: "openrouter:voice", input: "x".repeat(4_097) })).status, 400);
    assert.equal((await invalidSpeech({ model: "openrouter:voice", input: "hello", responseFormat: "wav" })).status, 400);
    assert.equal((await invalidSpeech({ model: "openrouter:unlisted-paid-model", input: "hello" })).status, 400);
    assert.equal((await invalidSpeech({ model: "openrouter:black-forest-labs/flux-speech:free", input: "hello", voice: "not-advertised" })).status, 400);
    assert.equal((await fetch(`${base}/admin/api/audio/transcriptions`, {
      method: "POST", headers: { ...dashboardHeaders, "content-type": "application/json" }, body: "{}"
    })).status, 415);

    const invalidForm = new FormData();
    invalidForm.append("file", new Blob([audioFile]), "sample.txt");
    invalidForm.append("model", "requesty:vendor/whisper");
    invalidForm.append("language", "EN");
    invalidForm.append("unknown", "value");
    assert.equal((await fetch(`${base}/admin/api/audio/transcriptions`, { method: "POST", headers: dashboardHeaders, body: invalidForm })).status, 400);
    const duplicateForm = new FormData();
    duplicateForm.append("file", new Blob([audioFile]), "sample.wav");
    duplicateForm.append("model", "requesty:one");
    duplicateForm.append("model", "requesty:two");
    assert.equal((await fetch(`${base}/admin/api/audio/transcriptions`, { method: "POST", headers: dashboardHeaders, body: duplicateForm })).status, 400);
    const emptyForm = new FormData();
    emptyForm.append("file", new Blob([]), "empty.wav");
    emptyForm.append("model", "requesty:vendor/whisper");
    assert.equal((await fetch(`${base}/admin/api/audio/transcriptions`, { method: "POST", headers: dashboardHeaders, body: emptyForm })).status, 400);
    const oversizedForm = new FormData();
    oversizedForm.append("file", new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]), "sample.wav");
    oversizedForm.append("model", "requesty:vendor/whisper");
    assert.equal((await fetch(`${base}/admin/api/audio/transcriptions`, { method: "POST", headers: dashboardHeaders, body: oversizedForm })).status, 413);

    const afterStatus = await fetch(`${base}/admin/api/status`, { headers: dashboardHeaders }).then((response) => response.json()) as { metrics: { totals: { requests: number }; recent: unknown[] } };
    const afterHistory = await fetch(`${base}/admin/api/history`, { headers: dashboardHeaders }).then((response) => response.json()) as { samples: unknown[]; retained: number };
    const prometheus = await fetch(`${base}/metrics`, { headers: dashboardHeaders }).then((response) => response.text());
    assert.equal(afterStatus.metrics.totals.requests, beforeStatus.metrics.totals.requests);
    assert.deepEqual(afterStatus.metrics.recent, beforeStatus.metrics.recent);
    assert.deepEqual({ samples: afterHistory.samples, retained: afterHistory.retained }, { samples: beforeHistory.samples, retained: beforeHistory.retained });
    for (const output of [capabilities, afterStatus, afterHistory, prometheus]) {
      assert.doesNotMatch(typeof output === "string" ? output : JSON.stringify(output), /local-stt-secret|upstream-local-secret|private-local|\/local\/v1/i);
    }
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
