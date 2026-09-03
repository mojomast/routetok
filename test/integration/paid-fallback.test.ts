import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv, stopChild } from "../support/process.js";

const PRIMARY = "openrouter:qwen/qwen3.7-flash";
const BACKUP_A = "openrouter:nex-agi/nex-n2-mini";
const BACKUP_B = "openrouter:deepseek/deepseek-v4-flash";
const BACKUP_C = "openrouter:upstage/solar-pro4";
const AGENT_LAST = "deepseek-v4-flash";

interface SummaryAttempt {
  p: string;
  m: string;
  s: number | null;
  o: string;
}

interface CapturedAttempt {
  scenario: string;
  body: Record<string, unknown>;
  provider: "openrouter" | "agentrouter";
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Proxy startup timed out: ${output}`)), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("RouteTok listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Proxy exited before startup with ${code}: ${output}`));
    });
  });
}

function decodeSummary(response: Response): SummaryAttempt[] {
  const encoded = response.headers.get("x-router-attempt-summary");
  assert(encoded, "attempt summary header is required");
  assert(encoded.length <= 4_096);
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    v: number;
    a: SummaryAttempt[];
  };
  assert.equal(parsed.v, 1);
  return parsed.a;
}

function success(model: unknown, content = "ok"): string {
  return JSON.stringify({
    id: "chatcmpl-local",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  });
}

test("exact paid OpenRouter fallback diagnostics and commit boundaries", async (suite) => {
  const calls: CapturedAttempt[] = [];
  let resolveRateLimitCancellation: (() => void) | undefined;
  const rateLimitCancellation = new Promise<void>((resolve) => { resolveRateLimitCancellation = resolve; });
  let resolveCommittedCancellation: (() => void) | undefined;
  const committedCancellation = new Promise<void>((resolve) => { resolveCommittedCancellation = resolve; });
  let releaseCommittedError: (() => void) | undefined;
  const committedErrorGate = new Promise<void>((resolve) => { releaseCommittedError = resolve; });
  const upstream = createServer(async (request, response) => {
    if (request.url === "/agent/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: AGENT_LAST,
        supported_endpoint_types: ["openai"],
        model_ratio: 1,
        completion_ratio: 1
      }] }));
      return;
    }
    if (request.url === "/openrouter/v1/models?output_modalities=all") {
      const models = ["qwen/qwen3.7-flash", "nex-agi/nex-n2-mini", "deepseek/deepseek-v4-flash", "upstage/solar-pro4"].map((id) => ({
        id,
        name: id,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools", "tool_choice", "max_tokens"],
        pricing: { prompt: "0.000001", completion: "0.000002" }
      }));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: models }));
      return;
    }
    if (request.url === "/openrouter/v1/key") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { usage: 0, limit: 10 } }));
      return;
    }
    if (request.url === "/opencode/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url !== "/openrouter/v1/chat/completions" && request.url !== "/agent/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    const payload = await requestBody(request);
    const scenario = String(payload.scenario ?? "");
    const provider = request.url.startsWith("/openrouter/") ? "openrouter" : "agentrouter";
    calls.push({ scenario, body: payload, provider });
    const model = String(payload.model);
    const primary = model === "qwen/qwen3.7-flash";

    if (scenario === "rate-limit" && primary) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.write(JSON.stringify({ error: { type: "rate_limit_error", message: "private upstream detail" } }));
      response.once("close", () => resolveRateLimitCancellation?.());
      return;
    }
    if (scenario === "all-rate-limited") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: { type: "rate_limit_error", message: "private upstream detail" } }));
      return;
    }
    if (scenario === "non-retryable" && primary) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "synthetic invalid request" } }));
      return;
    }
    const transient = /^http-(502|503|504)$/.exec(scenario);
    if (transient && primary) {
      response.writeHead(Number(transient[1]), { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "server_error", message: "private upstream detail" } }));
      return;
    }
    if (scenario === "single-504" && primary) {
      response.writeHead(504, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "server_error", message: "synthetic gateway timeout" } }));
      return;
    }
    if (scenario === "all-exhausted") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "server_error", message: `secret-${model}` } }));
      return;
    }
    if (scenario === "malformed" && primary) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "server_error", message: "HTTP 200 failure" } }));
      return;
    }
    if (scenario === "pre-output-timeout" && primary) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 50);
      response.once("close", () => clearInterval(heartbeat));
      return;
    }
    if (scenario === "nonstream-body-timeout" && primary) {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"id":"stalled"');
      return;
    }
    if (scenario === "connection-failure" && primary) {
      request.socket.destroy();
      return;
    }
    if (scenario === "pre-output-timeout") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fallback", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "fallback" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (scenario === "stream-tool-interruption") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = `data: ${JSON.stringify({ id: "tool-stream", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_once", type: "function", function: { name: "lookup", arguments: "{\"id\":" } }] }, finish_reason: null }] })}\n\n`;
      response.write(event);
      await committedErrorGate;
      response.write(`data: ${JSON.stringify({ error: { message: "synthetic interruption" } })}\n\n`);
      response.once("close", () => resolveCommittedCancellation?.());
      return;
    }
    if (scenario === "tool-success") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "tool", object: "chat.completion", model, choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_once", type: "function", function: { name: "lookup", arguments: "{\"id\":7}" } }] },
        finish_reason: "tool_calls"
      }] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(success(model));
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-paid-fallback-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      PROXY_API_KEY: "local-test-key",
      OPENROUTER_API_KEY: "mock-openrouter-key",
      OPENROUTER_BASE_URL: `${root}/openrouter/v1`,
      AGENTROUTER_API_KEY: "mock-agentrouter-key",
      AGENTROUTER_BASE_URL: `${root}/agent`,
      OPENCODE_ZEN_BASE_URL: `${root}/opencode`
    })
  });

  const endpoint = `http://127.0.0.1:${proxyPort}/v1/chat/completions`;
  const request = async (scenario: string, extra: Record<string, unknown> = {}): Promise<Response> => {
    const reset = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/circuits/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(reset.status, 200);
    return fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: PRIMARY, messages: [{ role: "user", content: "local fixture" }], scenario, ...extra })
    });
  };
  const scenarioCalls = (scenario: string): CapturedAttempt[] => calls.filter((call) => call.scenario === scenario);
  const patchConfig = async (patch: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    assert.equal(response.status, 200);
  };

  try {
    await ready(child);
    const configured = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabledExternalModels: [PRIMARY, BACKUP_A, BACKUP_B, BACKUP_C],
        paidOpenRouterFallbackOrder: [BACKUP_A, BACKUP_B, BACKUP_C],
        openaiOrder: [AGENT_LAST],
        fallbackExplicitModels: false,
        maxAttempts: 5,
        firstEventTimeoutMs: 1_000
      })
    });
    assert.equal(configured.status, 200);

    await suite.test("primary success uses exactly one attempt", async () => {
      const response = await request("primary-success");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-model"), PRIMARY);
      assert.equal(response.headers.get("x-router-route"), PRIMARY);
      assert.equal(response.headers.get("x-router-provider"), "openrouter");
      assert.equal(response.headers.get("x-router-attempts"), "1");
      assert.equal(response.headers.get("x-router-terminal"), "complete");
      assert.deepEqual(decodeSummary(response), [{ p: "openrouter", m: PRIMARY, s: 200, o: "success" }]);
      await response.text();
      assert.equal(scenarioCalls("primary-success").length, 1);
    });

    await suite.test("429 advances the paid chain and preserves the complete request body", async () => {
      const richBody = {
        messages: [{ role: "system", content: [{ type: "text", text: "system" }] }, { role: "user", content: "fixture" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { oneOf: [{ const: "a" }, { enum: ["b", "c"] }] } } } } }],
        tool_choice: { type: "function", function: { name: "lookup" } },
        max_tokens: 321,
        stream: false,
        extension_fixture: { nested: [1, { exact: true }] }
      };
      const response = await request("rate-limit", richBody);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-model"), BACKUP_A);
      assert.equal(response.headers.get("x-router-attempts"), "2");
      assert.equal(response.headers.get("x-router-terminal"), "complete");
      assert.deepEqual(decodeSummary(response).map(({ p, m, s, o }) => ({ p, m, s, o })), [
        { p: "openrouter", m: PRIMARY, s: 429, o: "rate_limited" },
        { p: "openrouter", m: BACKUP_A, s: 200, o: "success" }
      ]);
      await response.text();
      const attempts = scenarioCalls("rate-limit");
      assert.equal(attempts.length, 2);
      const normalized = attempts.map(({ body }) => ({ ...body, model: "physical-model" }));
      assert.deepEqual(normalized[0], normalized[1]);
      assert.deepEqual({ ...attempts[0]?.body, model: PRIMARY }, { model: PRIMARY, scenario: "rate-limit", ...richBody });
      await Promise.race([
        rateLimitCancellation,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("429 response body was not cancelled")), 2_000))
      ]);
    });

    for (const status of [502, 503, 504]) {
      await suite.test(`HTTP ${status} advances to the paid fallback`, async () => {
        const scenario = `http-${status}`;
        const response = await request(scenario);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-router-model"), BACKUP_A);
        assert.equal(response.headers.get("x-router-terminal"), "complete");
        assert.deepEqual(decodeSummary(response).map((item) => item.s), [status, 200]);
        await response.text();
        assert.equal(scenarioCalls(scenario).length, 2);
      });
    }

    await suite.test("an upstream HTTP 504 is not labeled as a local request timeout", async () => {
      await patchConfig({ paidOpenRouterFallbackOrder: [], openaiOrder: [], fallbackExplicitModels: false });
      try {
        const response = await request("single-504");
        assert.equal(response.status, 504);
        assert.equal(response.headers.get("x-router-terminal"), "fallback_exhausted");
        assert.equal(response.headers.get("x-router-attempts"), "1");
        await response.text();
      } finally {
        await patchConfig({ paidOpenRouterFallbackOrder: [BACKUP_A, BACKUP_B, BACKUP_C], openaiOrder: [AGENT_LAST] });
      }
    });

    await suite.test("pre-semantic-output timeout falls back", async () => {
      const response = await request("pre-output-timeout", { stream: true });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-model"), BACKUP_A);
      assert.equal(response.headers.get("x-router-terminal"), "stream_committed");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), ["transient_error", "stream_committed"]);
      assert.match(await response.text(), /fallback/);
      assert.equal(scenarioCalls("pre-output-timeout").length, 2);
    });

    await suite.test("stalled non-stream response body times out before commit and falls back", async () => {
      const response = await request("nonstream-body-timeout");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-model"), BACKUP_A);
      assert.equal(response.headers.get("x-router-terminal"), "complete");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), ["transient_error", "success"]);
      await response.text();
      assert.equal(scenarioCalls("nonstream-body-timeout").length, 2);
    });

    await suite.test("pre-output transport failure falls back", async () => {
      const response = await request("connection-failure");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-model"), BACKUP_A);
      assert.equal(response.headers.get("x-router-terminal"), "complete");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), ["transient_error", "success"]);
      await response.text();
      assert.equal(scenarioCalls("connection-failure").length, 2);
    });

    await suite.test("all configured paid and AgentRouter candidates synthesize stable exhaustion", async () => {
      const response = await request("all-exhausted");
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-router-terminal"), "fallback_exhausted");
      assert.equal(response.headers.get("x-router-model"), AGENT_LAST);
      assert.equal(response.headers.get("x-router-provider"), "agentrouter");
      assert.equal(response.headers.get("x-router-attempts"), "5");
      const summary = decodeSummary(response);
      assert.deepEqual(summary.map((item) => item.m), [PRIMARY, BACKUP_A, BACKUP_B, BACKUP_C, AGENT_LAST]);
      assert.deepEqual(summary.map((item) => item.p), ["openrouter", "openrouter", "openrouter", "openrouter", "agentrouter"]);
      const payload = await response.json() as { error: { type: string; code: string; message: string } };
      assert.equal(payload.error.type, "fallback_exhausted");
      assert.equal(payload.error.code, "fallback_exhausted");
      assert.doesNotMatch(JSON.stringify([...response.headers, payload]), /secret-|private upstream detail/);
    });

    await suite.test("all candidates rate limited synthesize stable exhaustion", async () => {
      const response = await request("all-rate-limited");
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("x-router-terminal"), "fallback_exhausted");
      assert.equal(response.headers.get("x-router-attempts"), "5");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), Array(5).fill("rate_limited"));
      const payload = await response.json() as { error: { type: string; code: string; message: string } };
      assert.equal(payload.error.type, "fallback_exhausted");
      assert.equal(payload.error.code, "fallback_exhausted");
      assert.doesNotMatch(JSON.stringify([...response.headers, payload]), /private upstream detail/);
    });

    await suite.test("non-retryable request error fails immediately", async () => {
      const response = await request("non-retryable");
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("x-router-terminal"), "non_retryable");
      assert.equal(response.headers.get("x-router-attempts"), "1");
      await response.text();
      assert.equal(scenarioCalls("non-retryable").length, 1);
    });

    await suite.test("retryable malformed HTTP 200 error envelope falls back", async () => {
      const response = await request("malformed");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-model"), BACKUP_A);
      assert.equal(response.headers.get("x-router-terminal"), "complete");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), ["transient_error", "success"]);
      await response.text();
      assert.equal(scenarioCalls("malformed").length, 2);
    });

    await suite.test("valid non-stream tool call commits without fallback", async () => {
      const response = await request("tool-success", { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-terminal"), "complete");
      assert.equal(response.headers.get("x-router-attempts"), "1");
      const payload = await response.json() as { choices: Array<{ message: { tool_calls: unknown[] } }> };
      assert.equal(payload.choices[0]?.message.tool_calls.length, 1);
      assert.equal(scenarioCalls("tool-success").length, 1);
    });

    await suite.test("streaming tool output commits before interruption and never falls back", async () => {
      const response = await request("stream-tool-interruption", { stream: true, tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-terminal"), "stream_committed");
      assert.equal(response.headers.get("x-router-attempts"), "1");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), ["stream_committed"]);
      releaseCommittedError?.();
      const text = await response.text();
      assert.equal((text.match(/call_once/g) ?? []).length, 1);
      assert.match(text, /synthetic interruption/);
      assert.equal(scenarioCalls("stream-tool-interruption").length, 1);
      await Promise.race([
        committedCancellation,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("committed upstream stream was not cancelled")), 2_000))
      ]);
    });
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
