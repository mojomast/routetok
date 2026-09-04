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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let diagnostics = "";
    const timer = setTimeout(() => reject(new Error(`RouteTok startup timed out: ${diagnostics}`)), 10_000);
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new Error(`${message}: ${diagnostics}`));
    };
    child.stdout?.on("data", (chunk) => {
      diagnostics += String(chunk);
      if (diagnostics.includes("RouteTok listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
    child.once("error", (error) => fail(`RouteTok failed to spawn (${error.message})`));
    child.once("exit", (code) => fail(`RouteTok exited before startup (${code})`));
  });
}

function openAiChunk(partial: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: partial, finish_reason: null }] })}\n\n`;
}

function sse(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join("") + "data: [DONE]\n\n";
}

test("dashboard sandbox passes tools and tool-result history through both protocols", async () => {
  const openAiBodies: Array<Record<string, unknown>> = [];
  const anthropicBodies: Array<Record<string, unknown>> = [];
  let openAiStep = 0;
  const upstream = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: [{ model_name: "sandbox-tools-model", supported_endpoint_types: ["openai", "anthropic"], model_ratio: 1, completion_ratio: 1 }]
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      openAiBodies.push(await readJson(request));
      openAiStep += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (openAiStep === 1) {
        response.end(openAiChunk({
          content: "",
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "time_now", arguments: "{}" } }]
        }) + "data: [DONE]\n\n");
      } else {
        response.end(openAiChunk({ content: "The current time is 12:00." }) + "data: [DONE]\n\n");
      }
      return;
    }
    if (request.method === "POST" && request.url === "/v1/messages") {
      anthropicBodies.push(await readJson(request));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        { type: "message_start", message: { id: "msg_1", model: "sandbox-tools-model", usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "time_now", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"zone":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"utc"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" }
      ];
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-sandbox-tools-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      AGENTROUTER_API_KEY: "local-upstream-key",
      AGENTROUTER_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`
    })
  });
  const endpoint = `http://127.0.0.1:${proxyPort}/admin/api/sandbox`;

  try {
    await waitForReady(child);
    const sandboxRequest = (body: Record<string, unknown>) => fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const tool = { name: "time_now", description: "Return the current UTC time", input_schema: { type: "object", properties: {} } };

    const first = await sandboxRequest({
      purpose: "chat",
      tools: [tool],
      requests: [{ id: "branch_1", model: "sandbox-tools-model", messages: [{ role: "user", content: "What time is it?" }] }]
    });
    assert.equal(first.status, 200);
    const firstPayload = await first.json() as { results: Array<Record<string, unknown>> };
    const firstResult = firstPayload.results[0]!;
    assert.equal(firstResult.error ?? null, null);
    assert.deepEqual(firstResult.toolCalls, [{ id: "call_1", name: "time_now", args: {} }]);
    assert.equal(openAiBodies.length, 1);
    const firstUpstream = openAiBodies[0]!;
    assert.deepEqual(firstUpstream.tools, [{ type: "function", function: { name: "time_now", description: tool.description, parameters: tool.input_schema } }]);
    assert.deepEqual(firstUpstream.messages, [{ role: "user", content: "What time is it?" }]);

    const second = await sandboxRequest({
      purpose: "chat",
      tools: [tool],
      requests: [{
        id: "branch_1",
        model: "sandbox-tools-model",
        messages: [
          { role: "user", content: "What time is it?" },
          { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "time_now", args: {} }] },
          { role: "tool", tool_call_id: "call_1", content: '{"now":"2026-09-04T12:00:00.000Z"}' }
        ]
      }]
    });
    assert.equal(second.status, 200);
    const secondPayload = await second.json() as { results: Array<Record<string, unknown>> };
    const secondResult = secondPayload.results[0]!;
    assert.equal(secondResult.error ?? null, null);
    assert.equal(secondResult.content, "The current time is 12:00.");
    assert.equal("toolCalls" in secondResult, false);
    const secondUpstream = openAiBodies[1]!;
    const upstreamMessages = secondUpstream.messages as Array<Record<string, unknown>>;
    assert.equal(upstreamMessages.length, 3);
    assert.equal((upstreamMessages[1] as { role: string; tool_calls: Array<{ id: string; function: { arguments: string } }> }).tool_calls[0]!.function.arguments, "{}");
    assert.equal((upstreamMessages[2] as { role: string }).role, "tool");

    const third = await sandboxRequest({
      purpose: "chat",
      protocol: "anthropic",
      tools: [tool],
      requests: [{ id: "branch_1", model: "sandbox-tools-model", messages: [{ role: "user", content: "Report the current time zone" }] }]
    });
    assert.equal(third.status, 200);
    const thirdPayload = await third.json() as { results: Array<Record<string, unknown>> };
    assert.deepEqual(thirdPayload.results[0]!.toolCalls, [{ id: "toolu_1", name: "time_now", args: { zone: "utc" } }], `anthropic result: ${JSON.stringify(thirdPayload.results[0]!)}`);
    const anthropicUpstream = anthropicBodies[0]!;
    assert.deepEqual(anthropicUpstream.tools, [{ name: "time_now", description: tool.description, input_schema: tool.input_schema }]);
    assert.deepEqual(anthropicUpstream.messages, [{ role: "user", content: "Report the current time zone" }]);

    const invalidCases: Array<{ name: string; body: Record<string, unknown>; reason: RegExp }> = [
      { name: "too many tools", body: { purpose: "chat", tools: Array.from({ length: 17 }, () => tool), requests: [{ id: "a", model: "sandbox-tools-model", messages: [{ role: "user", content: "hi" }] }] }, reason: /1 to 16/ },
      { name: "invalid tool name", body: { purpose: "chat", tools: [{ ...tool, name: "TimeNow" }], requests: [{ id: "a", model: "sandbox-tools-model", messages: [{ role: "user", content: "hi" }] }] }, reason: /match \^\[a-z0-9_\]/ },
      { name: "missing input schema", body: { purpose: "chat", tools: [{ name: "bare", description: "d" }], requests: [{ id: "a", model: "sandbox-tools-model", messages: [{ role: "user", content: "hi" }] }] }, reason: /input_schema/ },
      { name: "unmatched tool result", body: { purpose: "chat", requests: [{ id: "a", model: "sandbox-tools-model", messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "call_zzz", content: "x" }] }] }, reason: /unknown tool call/ },
      { name: "unanswered tool call", body: { purpose: "chat", requests: [{ id: "a", model: "sandbox-tools-model", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "time_now", args: {} }] }] }] }, reason: /unanswered/ },
      { name: "invalid protocol", body: { purpose: "chat", protocol: "grpc", requests: [{ id: "a", model: "sandbox-tools-model", messages: [{ role: "user", content: "hi" }] }] }, reason: /protocol/ }
    ];
    for (const invalidCase of invalidCases) {
      const response = await sandboxRequest(invalidCase.body);
      assert.equal(response.status, 400, invalidCase.name);
      const payload = await response.json() as { error?: string };
      assert.match(payload.error ?? "", invalidCase.reason, invalidCase.name);
    }
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
