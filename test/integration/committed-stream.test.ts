import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv, stopChild } from "../support/process.js";

const GOOD = "good-model";
const BAD = "bad-model";
const CASCADE = "phantom-cascade";

interface SummaryAttempt {
  p: string;
  m: string;
  s: number | null;
  o: string;
}

function decodeSummary(response: Response): SummaryAttempt[] {
  const encoded = response.headers.get("x-router-attempt-summary");
  assert(encoded, "attempt summary header is required");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    v: number;
    a: SummaryAttempt[];
  };
  assert.equal(parsed.v, 1);
  return parsed.a;
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
    const timer = setTimeout(() => reject(new Error(`Proxy startup timed out: ${output}`)), 20_000);
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

test("committed streams emit truthful terminal frames and detach the overall deadline", async (suite) => {
  const calls: string[] = [];
  let keepaliveTimers = 0;
  const upstream = createServer(async (request, response) => {
    if (request.url === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        { model_name: GOOD, supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1 },
        { model_name: BAD, supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1 }
      ] }));
      return;
    }
    if (request.url !== "/v1/chat/completions" && request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const responsesWire = request.url === "/v1/responses";
    const payload = await requestBody(request);
    const model = String(payload.model);
    const content = JSON.stringify(payload.messages ?? payload.input ?? "");
    calls.push(`${model}:${responsesWire ? "responses" : "chat"}`);
    const chatDelta = (text: string): string => `data: ${JSON.stringify({
      id: "chatcmpl-committed", object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    })}\n\n`;
    const chatFinish = (): string => `data: ${JSON.stringify({
      id: "chatcmpl-committed", object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\ndata: [DONE]\n\n`;
    const chatError = (message: string): string => `data: ${JSON.stringify({
      error: { message, type: "server_error", code: "upstream_error" }
    })}\n\n`;
    const resDelta = (text: string): string => `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta", delta: text, sequence_number: 0
    })}\n\n`;
    const resError = (message: string): string => `event: error\ndata: ${JSON.stringify({
      type: "error", code: "upstream_error", message, param: null, sequence_number: 1
    })}\n\n`;

    if (content.includes("phantom") && model === BAD) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => response.write(": keepalive\n\n"), 100);
      keepaliveTimers += 1;
      response.once("close", () => {
        clearInterval(timer);
        keepaliveTimers -= 1;
      });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    if (model === BAD) {
      response.end(chatDelta("unexpected-bad-commit"));
      return;
    }
    if (content.includes("flat-error") && !responsesWire) {
      response.write(chatDelta("HELLO-0"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.write(chatError("synthetic mid-stream failure"));
      response.end();
      return;
    }
    if (content.includes("flat-responses") && responsesWire) {
      response.write(resDelta("RESP-0"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.write(resError("responses boom"));
      response.end();
      return;
    }
    if (content.includes("clean-eof")) {
      response.write(chatDelta("EOF-0"));
      response.end();
      return;
    }
    if (content.includes("idle-committed")) {
      response.write(chatDelta("IDLE-0"));
      return;
    }
    if (content.includes("keeps-streaming")) {
      for (let index = 0; index <= 20; index += 1) {
        response.write(chatDelta(`chunk-${index}`));
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      response.end(chatFinish());
      return;
    }
    response.end(chatFinish());
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-committed-stream-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      PROXY_API_KEY: "local-test-key",
      AGENTROUTER_API_KEY: "mock-agentrouter-key",
      AGENTROUTER_BASE_URL: `http://127.0.0.1:${address.port}`
    })
  });

  const chatEndpoint = `http://127.0.0.1:${proxyPort}/v1/chat/completions`;
  const responsesEndpoint = `http://127.0.0.1:${proxyPort}/v1/responses`;
  const patchConfig = async (patch: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    assert.equal(response.status, 200);
  };
  const resetCircuits = async (): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/circuits/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
  };
  const streamChat = async (content: string): Promise<{ response: Response; text: string }> => {
    const response = await fetch(chatEndpoint, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: GOOD, stream: true, messages: [{ role: "user", content }] })
    });
    assert.equal(response.status, 200);
    return { response, text: await response.text() };
  };
  const recordOf = async (requestId: string): Promise<{
    status: number;
    error: string | null;
    attempts: Array<{ outcome: string; error?: string; status: number | null }>;
  }> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((result) => result.json()) as {
        metrics: { recent: Array<Record<string, unknown> & { id: string; status: number; error: string | null; attempts: Array<{ outcome: string; error?: string; status: number | null }> }> };
      };
      const record = status.metrics.recent.find((entry) => entry.id === requestId);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("request record never became available");
  };

  try {
    await ready(child);
    await patchConfig({ fallbackExplicitModels: false });

    await suite.test("a committed OpenAI-Chat stream error relays the frame and appends an error frame plus [DONE]", async () => {
      await resetCircuits();
      const { response, text } = await streamChat("flat-error");
      assert.equal(response.headers.get("x-router-terminal"), "stream_committed");
      assert.equal(response.headers.get("x-router-attempts"), "1");
      assert.deepEqual(decodeSummary(response).map((item) => item.o), ["stream_committed"]);
      assert.match(text, /HELLO-0/);
      assert.match(text, /synthetic mid-stream failure/);
      assert.match(text, /"code":"stream_interrupted"/);
      assert.match(text, /"reason":"upstream_error"/);
      assert.match(text, /data: \[DONE\]\n\n$/);
    });

    await suite.test("a committed Responses flat error event is relayed with its event line", async () => {
      await resetCircuits();
      const response = await fetch(responsesEndpoint, {
        method: "POST",
        headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
        body: JSON.stringify({ model: GOOD, stream: true, input: "flat-responses" })
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-terminal"), "stream_committed");
      const text = await response.text();
      assert.match(text, /RESP-0/);
      assert.match(text, /event: error\ndata: .*"message":"responses boom"/);
      assert.match(text, /"code":"stream_interrupted"/);
      assert.doesNotMatch(text, /data: \[DONE\]/);
    });

    await suite.test("a clean EOF without a terminal event produces a truthful error frame and [DONE]", async () => {
      await resetCircuits();
      const { response, text } = await streamChat("clean-eof");
      const requestId = response.headers.get("x-request-id");
      assert(requestId);
      assert.match(text, /EOF-0/);
      assert.match(text, /"code":"stream_interrupted"/);
      assert.match(text, /"reason":"upstream_error"/);
      assert.match(text, /data: \[DONE\]\n\n$/);
      const record = await recordOf(requestId);
      assert.equal(record.status, 200);
      assert.match(record.error ?? "", /stream ended without a terminal event/);
      assert.match(record.attempts[0]?.error ?? "", /stream ended without a terminal event/);
    });

    await suite.test("an idle committed stream past the overall deadline emits the idle frame, not a deadline truncation", async () => {
      await resetCircuits();
      await patchConfig({ streamIdleTimeoutMs: 5_000 });
      const started = Date.now();
      const { response, text } = await streamChat("idle-committed");
      assert.equal(response.headers.get("x-router-terminal"), "stream_committed");
      assert.match(text, /IDLE-0/);
      assert.match(text, /"reason":"idle_timeout"/);
      assert.match(text, /data: \[DONE\]\n\n$/);
      assert(Date.now() - started >= 4_000, "idle frame must wait for the idle bound");
    });

    await suite.test("a committed stream keeps producing tokens past the overall deadline", async () => {
      await resetCircuits();
      await patchConfig({ requestTimeoutMs: 5_000 });
      const { response, text } = await streamChat("keeps-streaming");
      assert.equal(response.headers.get("x-router-terminal"), "stream_committed");
      assert.match(text, /chunk-19/);
      assert.match(text, /chunk-20/);
      assert.match(text, /data: \[DONE\]\n\n$/);
      assert.doesNotMatch(text, /stream_interrupted/);
    });

    await suite.test("overall-deadline expiry during pre-output prepare does not dispatch a phantom attempt", async () => {
      await resetCircuits();
      await patchConfig({
        requestTimeoutMs: 5_000,
        customCascades: [{ name: CASCADE, members: [BAD, GOOD] }]
      });
      const before = calls.length;
      const response = await fetch(chatEndpoint, {
        method: "POST",
        headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
        body: JSON.stringify({ model: CASCADE, stream: true, messages: [{ role: "user", content: "phantom deadline" }] })
      });
      assert.equal(response.status, 504);
      assert.equal(response.headers.get("x-router-terminal"), "request_timeout");
      assert.equal(response.headers.get("x-router-model"), BAD);
      assert.equal(response.headers.get("x-router-attempts"), "1");
      assert.deepEqual(decodeSummary(response), [{ p: "agentrouter", m: BAD, s: 200, o: "transient_error" }]);
      await response.text();
      const dispatched = calls.slice(before);
      assert.deepEqual(dispatched, [`${BAD}:chat`], "only the in-flight candidate may be contacted");
      await patchConfig({ requestTimeoutMs: 600_000, customCascades: [] });
    });
  } finally {
    assert.equal(keepaliveTimers, 0, "mock keepalive timers must be cleaned up");
    await stopChild(child);
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
