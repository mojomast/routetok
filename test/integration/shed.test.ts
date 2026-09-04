import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv, stopChild } from "../support/process.js";

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

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("client-path in-flight shed returns 429 with retry-after past maxInflightRequests", async () => {
  const upstreamCalls: string[] = [];
  const held: Array<() => void> = [];
  let holdUpstream = true;
  const upstream = createServer(async (request, response) => {
    if (request.url === "/agent/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1
      }] })); return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      await requestBody(request);
      upstreamCalls.push(request.url);
      if (holdUpstream) {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "held-ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-shed-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], env: isolatedTestEnv({
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
      PROXY_API_KEY: "local", DASHBOARD_TOKEN: "dashboard-secret",
      AGENTROUTER_API_KEY: "agent-secret", AGENTROUTER_BASE_URL: `${root}/agent`
    })
  });
  try {
    await ready(child);
    const base = `http://127.0.0.1:${port}`;
    const dashboardHeaders = { "x-dashboard-token": "dashboard-secret" };
    const capped = await fetch(`${base}/admin/api/config`, {
      method: "PATCH", headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ maxInflightRequests: 2 })
    });
    assert.equal(capped.status, 200);

    const proxy = (content: string) => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", messages: [{ role: "user", content }] })
    });

    const first = proxy("first in flight");
    await until(() => held.length === 1);
    const second = proxy("second in flight");
    await until(() => held.length === 2);
    const shed = await proxy("third must shed");
    assert.equal(shed.status, 429);
    assert.equal(shed.headers.get("retry-after"), "1", "shed requests carry a retry-after window");
    const shedBody = await shed.json() as { error?: { message: string; type: string } };
    assert.equal(shedBody.error?.type, "rate_limit_error");

    held.shift()?.();
    assert.equal((await first).status, 200);
    held.shift()?.();
    assert.equal((await second).status, 200);
    holdUpstream = false;
    const afterDrain = await proxy("gate released");
    assert.equal(afterDrain.status, 200, "the gate releases once in-flight requests finish");
    await afterDrain.text();

    const badBound = await fetch(`${base}/admin/api/config`, {
      method: "PATCH", headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ maxInflightRequests: 0 })
    });
    assert.equal(badBound.status, 400);
    assert.equal(upstreamCalls.length, 3, "the shed request never reached any upstream");
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
