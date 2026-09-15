import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
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

function sse(response: ServerResponse, values: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const value of values) response.write(`data: ${JSON.stringify(value)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false
};

test("AgentRouter DeepSeek structured output is shimmed through the HTTP proxy", async (suite) => {
  const calls: Record<string, unknown>[] = [];
  const models = ["deepseek-v4-flash", "glm-5.3"];
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
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    calls.push(payload);
    const tools = Array.isArray(payload.tools) ? payload.tools as Array<{ function?: { name?: string } }> : [];
    const schemaTool = tools.map((tool) => tool.function?.name)
      .find((name): name is string => typeof name === "string" && name.startsWith("routetok_json_schema")) ?? null;
    const forced = Boolean(payload.tool_choice && typeof payload.tool_choice === "object" &&
      (payload.tool_choice as Record<string, unknown>).type === "function");
    if (schemaTool === null) {
      if (payload.stream) {
        sse(response, [
          { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
        ]);
      } else {
        response.end(JSON.stringify({
          id: "chat-local", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
        }));
      }
      return;
    }
    if (payload.stream) {
      sse(response, [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: schemaTool, arguments: "" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"ok\":" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }] }
      ]);
    } else if (!forced && payload.test_auto_empty === true) {
      response.end(JSON.stringify({
        id: "chat-local", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "Budget spent thinking." }, finish_reason: "length" }]
      }));
    } else {
      response.end(JSON.stringify({
        id: "chat-local", object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant", content: "", reasoning_content: "Reasoned about the schema.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: schemaTool, arguments: "{\"ok\": true}" } }]
          },
          finish_reason: "tool_calls"
        }]
      }));
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
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-structured-"));
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
  const request = (body: Record<string, unknown>) => fetch(`${proxy}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64, ...body })
  });
  const structuredRequest = { messages: [{ role: "user", content: "Return the structured result" }], response_format: { type: "json_schema", json_schema: { name: "probe", strict: true, schema: SCHEMA } } };
  try {
    await ready(child);
    const configured = await fetch(`${proxy}/admin/api/config`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxAttempts: 1, fallbackExplicitModels: false })
    });
    assert.equal(configured.status, 200, await configured.text());

    await suite.test("non-stream json_schema prefers auto and keeps thinking enabled", async () => {
      calls.length = 0;
      const response = await request(structuredRequest);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const payload = JSON.parse(text) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> };
      assert.equal(payload.choices[0]?.message.content, "{\"ok\": true}");
      assert.equal(payload.choices[0]?.message.tool_calls, undefined);
      assert.equal(payload.choices[0]?.message.reasoning_content, "Reasoned about the schema.");
      assert.equal(payload.choices[0]?.finish_reason, "stop");
      assert.equal(response.headers.get("x-router-model"), "deepseek-v4-flash");
      assert.equal(calls.length, 1, "a usable auto response must not trigger the fallback");
      const sent = calls[0];
      assert(sent);
      assert.equal(sent.response_format, undefined, "upstream must not receive response_format");
      assert.equal(sent.tool_choice, "auto");
      assert.equal(Object.hasOwn(sent, "thinking"), false, "thinking must stay enabled for the auto path");
      const tools = sent.tools as Array<{ function: { name: string; parameters: unknown } }>;
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.function.name, "routetok_json_schema");
      assert.deepEqual(tools[0]?.function.parameters, SCHEMA);
    });

    await suite.test("an unusable auto response falls back once to a forced non-thinking tool call", async () => {
      calls.length = 0;
      const response = await request({ ...structuredRequest, test_auto_empty: true });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const payload = JSON.parse(text) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> };
      assert.equal(payload.choices[0]?.message.content, "{\"ok\": true}");
      assert.equal(payload.choices[0]?.message.tool_calls, undefined);
      assert.equal(payload.choices[0]?.finish_reason, "stop");
      assert.equal(calls.length, 2, "exactly one bounded fallback attempt");
      assert.equal(calls[0]?.tool_choice, "auto");
      assert.equal(Object.hasOwn(calls[0] ?? {}, "thinking"), false);
      const forced = calls[1];
      assert(forced);
      assert.equal((forced.tool_choice as Record<string, unknown>).type, "function");
      assert.deepEqual(forced.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(forced, "reasoning_effort"), false);
    });

    await suite.test("streamed json_schema becomes content deltas and [DONE]", async () => {
      calls.length = 0;
      const response = await request({ ...structuredRequest, stream: true });
      const wire = await response.text();
      assert.equal(response.status, 200, wire);
      assert.ok(!wire.includes("tool_calls"), "synthetic tool deltas must not reach the client");
      const content = wire.split("\n\n")
        .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
        .flatMap((block) => (JSON.parse(block.slice(6)) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> }).choices ?? [])
        .map((entry) => entry.delta?.content)
        .filter((entry): entry is string => typeof entry === "string")
        .join("");
      assert.equal(content, "{\"ok\":true}");
      assert.match(wire, /"finish_reason":"stop"/);
      assert.match(wire, /data: \[DONE\]/);
      assert.equal(calls[0]?.tool_choice, "auto");
    });

    await suite.test("thinking:false is normalized to the structured shape", async () => {
      calls.length = 0;
      const response = await request({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
        tool_choice: "auto",
        thinking: false
      });
      assert.equal(response.status, 200, await response.text());
      const sent = calls.at(-1);
      assert(sent);
      assert.deepEqual(sent.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(sent, "enable_thinking"), false);
    });

    await suite.test("enable_thinking:false is normalized without forcing a tool call", async () => {
      calls.length = 0;
      const response = await request({ messages: [{ role: "user", content: "hi" }], enable_thinking: false });
      assert.equal(response.status, 200, await response.text());
      const sent = calls.at(-1);
      assert(sent);
      assert.deepEqual(sent.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(sent, "enable_thinking"), false);
      assert.equal(sent.tool_choice, undefined);
    });

    await suite.test("json_object is passed through untouched", async () => {
      calls.length = 0;
      const response = await request({ messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } });
      assert.equal(response.status, 200, await response.text());
      const sent = calls.at(-1);
      assert(sent);
      assert.deepEqual(sent.response_format, { type: "json_object" });
      assert.equal(sent.tools, undefined);
    });
  } finally {
    await stopChild(child);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
