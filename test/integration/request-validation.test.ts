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

function safeErrorMessage(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  return error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
}

test("request validation is local while valid and malformed tool schemas pass through", async () => {
  const inferenceBodies: Record<string, unknown>[] = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: [{ model_name: "validation-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1 }]
      }));
      return;
    }
    if (request.url === "/opencode/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "local-free-model" }] }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      inferenceBodies.push(await readJson(request));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "local-result",
        object: "chat.completion",
        model: "validation-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
      }));
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-validation-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      PROXY_API_KEY: "local-test-key",
      AGENTROUTER_API_KEY: "local-upstream-key",
      AGENTROUTER_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}/opencode`
    })
  });
  const endpoint = `http://127.0.0.1:${proxyPort}/v1/chat/completions`;
  const headers = { authorization: "Bearer local-test-key", "content-type": "application/json" };

  try {
    await waitForReady(child);

    const closedParameters = {
      type: "object",
      additionalProperties: false,
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
        selection: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { kind: { const: "left" }, left: { type: "string" } },
              required: ["kind", "left"]
            },
            {
              type: "object",
              additionalProperties: false,
              properties: { kind: { const: "right" }, right: { type: "integer" } },
              required: ["kind", "right"]
            }
          ]
        }
      },
      required: ["tags", "selection"]
    };
    const validBody = {
      model: "validation-model",
      messages: [{ role: "user", content: "x" }],
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "f", description: "x", parameters: closedParameters } }]
    };
    const valid = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(validBody) });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("x-router-model"), "validation-model");
    assert.equal(valid.headers.get("x-router-provider"), "agentrouter");
    assert.equal((await valid.json() as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, "ok");
    assert.deepEqual(inferenceBodies[0], validBody);
    assert.equal("strict" in ((inferenceBodies[0]?.tools as Array<{ function: object }>)[0]?.function ?? {}), false);

    const malformedSchemaBody = {
      model: "validation-model",
      messages: [{ role: "user", content: "y" }],
      tools: [{ type: "function", function: { name: "g", parameters: { type: "object", required: "not-an-array", oneOf: "not-an-array" } } }]
    };
    const malformedSchema = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(malformedSchemaBody) });
    assert.equal(malformedSchema.status, 200);
    await malformedSchema.text();
    assert.deepEqual(inferenceBodies[1], malformedSchemaBody);

    const invalidCases: Array<{ name: string; raw: string; reason: string }> = [
      { name: "malformed JSON", raw: "{", reason: "request body must be valid JSON" },
      { name: "non-boolean stream", raw: JSON.stringify({ model: "validation-model", stream: "x" }), reason: "stream must be a boolean" },
      { name: "missing model", raw: "{}", reason: "model must be a non-empty string" },
      { name: "empty model", raw: JSON.stringify({ model: " " }), reason: "model must be a non-empty string" },
      { name: "non-string model", raw: JSON.stringify({ model: 1 }), reason: "model must be a non-empty string" },
      { name: "array body", raw: "[]", reason: "request body must be a JSON object" },
      { name: "null body", raw: "null", reason: "request body must be a JSON object" },
      { name: "scalar body", raw: JSON.stringify("x"), reason: "request body must be a JSON object" }
    ];
    const callsBeforeInvalidRequests = inferenceBodies.length;
    for (const invalidCase of invalidCases) {
      const response = await fetch(endpoint, { method: "POST", headers, body: invalidCase.raw });
      assert.equal(response.status, 400, invalidCase.name);
      assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i, invalidCase.name);
      assert.equal(response.headers.get("x-router-model"), null, invalidCase.name);
      assert.equal(response.headers.get("x-router-provider"), null, invalidCase.name);
      assert.equal(response.headers.get("x-router-terminal"), "invalid_request", invalidCase.name);
      const payload = await response.json();
      assert.equal(safeErrorMessage(payload), invalidCase.reason, invalidCase.name);
      assert.equal(inferenceBodies.length, callsBeforeInvalidRequests, `${invalidCase.name} reached upstream inference`);
    }
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
