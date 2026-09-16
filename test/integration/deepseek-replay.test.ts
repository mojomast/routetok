import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv, stopChild } from "../support/process.js";

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

test("AgentRouter DeepSeek replay safeguard is narrow and isolated per attempt", async (suite) => {
  const calls: Record<string, unknown>[] = [];
  const models = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro-preview", "deepseek-v3", "deepseek-v4-flashlight", "backup"];
  const upstream = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/agent/api/pricing") {
      response.end(JSON.stringify({ data: models.map((model_name) => ({
        model_name, supported_endpoint_types: ["openai", "anthropic"], model_ratio: 1, completion_ratio: 1
      })) }));
      return;
    }
    if (request.url === "/opencode/models") {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === "/openrouter/v1/models?output_modalities=all") {
      response.end(JSON.stringify({ data: [{
        id: "deepseek-v4-flash", architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" }
      }] }));
      return;
    }
    if (!request.url?.endsWith("/chat/completions") && !request.url?.endsWith("/responses") && !request.url?.endsWith("/messages")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    calls.push(payload);
    if (payload.fallback_fixture && payload.model === "deepseek-v4-flash") {
      response.writeHead(503).end(JSON.stringify({ error: { message: "synthetic failure" } }));
      return;
    }
    if (request.url.endsWith("/responses")) {
      response.end(JSON.stringify({ id: "resp-local", object: "response", output: [] }));
    } else if (request.url.endsWith("/messages")) {
      response.end(JSON.stringify({ id: "msg-local", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    } else {
      response.end(JSON.stringify({ id: "chat-local", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const proxyAddress = reservation.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-deepseek-replay-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1", PORT: String(proxyAddress.port), DATA_DIR: dataDir,
      PROXY_API_KEY: "local-test-key", DASHBOARD_TOKEN: "", AGENTROUTER_API_KEY: "mock-key",
      AGENTROUTER_BASE_URL: `${root}/agent`, OPENCODE_ZEN_BASE_URL: `${root}/opencode`,
      OPENROUTER_API_KEY: "mock-key", OPENROUTER_BASE_URL: `${root}/openrouter/v1`
    })
  });
  const proxy = `http://127.0.0.1:${proxyAddress.port}`;
  const history = [
    { role: "user", content: "Check something" },
    { role: "assistant", content: "A plain earlier answer" },
    { role: "assistant", content: null, reasoning_content: "Existing reasoning", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" }
  ];
  const original = {
    model: "deepseek-v4-flash", messages: history,
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    tool_choice: "auto", extension_fixture: { preserve: [1, "two"] }
  };
  async function send(body: Record<string, unknown>, endpoint = "/v1/chat/completions"): Promise<void> {
    calls.length = 0;
    const response = await fetch(`${proxy}${endpoint}`, {
      method: "POST", headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, await response.text());
  }
  try {
    await ready(child);
    const configured = await fetch(`${proxy}/admin/api/config`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ openaiOrder: ["backup"], fallbackExplicitModels: true, maxAttempts: 2,
        enabledExternalModels: ["openrouter:deepseek-v4-flash"], paidOpenRouterFallbackOrder: [] })
    });
    assert.equal(configured.status, 200, await configured.text());
    for (const model of models.slice(0, 3)) {
      await suite.test(`disables default thinking on ${model} without changing history`, async () => {
        await send({ ...original, model });
        assert.deepEqual(calls, [{ ...original, model, thinking: { type: "disabled" } }]);
      });
    }
    for (const reasoning_content of [null, 123, {}, []]) {
      await suite.test(`non-string reasoning ${JSON.stringify(reasoning_content)}`, async () => {
        const body = { ...original, messages: [{ role: "assistant", content: "answer", reasoning_content }] };
        await send(body);
        assert.deepEqual(calls, [{ ...body, thinking: { type: "disabled" } }]);
      });
    }
    const unchanged: [string, Record<string, unknown>, string?][] = [
      ["explicit thinking enabled", { ...original, thinking: { type: "enabled" } }],
      ["explicit thinking disabled", { ...original, thinking: { type: "disabled" } }],
      ["explicit null thinking", { ...original, thinking: null }],
      ["explicit reasoning effort", { ...original, reasoning_effort: "high" }],
      ["explicit null reasoning effort", { ...original, reasoning_effort: null }],
      ["complete replay including empty reasoning", { ...original, messages: history.map((message) => message.role === "assistant" ? { ...message, reasoning_content: message.reasoning_content ?? "" } : message) }],
      ["initial request", { ...original, messages: [{ role: "user", content: "hello" }] }],
      ["empty tools", { ...original, tools: [] }],
      ["no tools", { model: original.model, messages: history }],
      ["older model", { ...original, model: "deepseek-v3" }],
      ["unrelated prefix", { ...original, model: "deepseek-v4-flashlight" }],
      ["other provider", { ...original, model: "openrouter:deepseek-v4-flash" }],
      ["Responses endpoint", original, "/v1/responses"],
      ["Anthropic endpoint", { ...original, messages: [{ role: "assistant", content: "plain answer" }], max_tokens: 16 }, "/v1/messages"]
    ];
    for (const [name, body, endpoint] of unchanged) {
      await suite.test(name, async () => {
        await send(body, endpoint);
        assert.deepEqual(calls, [{ ...body, model: String(body.model).replace(/^openrouter:/, "") }]);
      });
    }
    await suite.test("fallback gets original body, not injected thinking", async () => {
      const body = { ...original, fallback_fixture: true };
      await send(body);
      assert.deepEqual(calls, [
        { ...body, thinking: { type: "disabled" } },
        { ...body, model: "backup" }
      ]);
    });
  } finally {
    await stopChild(child);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
