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

async function waitForReady(child: ChildProcess): Promise<void> {
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

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("sandbox lane shed returns 429 with retry-after while eight lanes are in flight", async () => {
  let held = 0;
  const holdLatch = { release: null as (() => void) | null };
  let holdGate: Promise<void> | null = null;
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1
      }] }));
      return;
    }
    if (url.pathname === "/v1/chat/completions") {
      const payload = await requestBody(request);
      const marker = JSON.stringify(payload.messages ?? []);
      if (marker.includes("HOLD-ME")) {
        held += 1;
        if (!holdGate) holdGate = new Promise<void>((resolve) => { holdLatch.release = resolve; });
        await holdGate;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "ok", object: "chat.completion", model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: "SHED-OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 }
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-sandbox-shed-"));
  const dashboardHeaders = { "x-dashboard-token": "dashboard-secret" };
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      DASHBOARD_TOKEN: "dashboard-secret",
      AGENTROUTER_API_KEY: "agent-secret",
      AGENTROUTER_BASE_URL: root
    })
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  const branch = (id: string, content: string) => ({
    id, model: "agent-model",
    messages: [{ role: "user", content }]
  });
  try {
    await waitForReady(child);
    const baseline = await fetch(`${base}/admin/api/sandbox`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [branch("baseline", "plain request")] })
    });
    assert.equal(baseline.status, 200, "a plain sandbox request must pass when lanes are free");

    const heldRequest = (count: number) => fetch(`${base}/admin/api/sandbox`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: Array.from({ length: 4 }, (_, index) => branch(`hold-${count}-${index}`, "HOLD-ME")) })
    });
    const first = heldRequest(1);
    const second = heldRequest(2);
    await until(() => holdLatch.release !== null && held >= 8, 5_000);

    const shed = await fetch(`${base}/admin/api/sandbox`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [branch("shed", "must shed")] })
    });
    assert.equal(shed.status, 429);
    assert.equal(shed.headers.get("retry-after"), "1", "shed sandbox requests carry a retry-after window");
    const shedBody = await shed.json() as { error: string };
    assert.equal(shedBody.error, "Sandbox concurrency limit reached");

    const proposalShed = await fetch(`${base}/admin/api/config/proposals/generate`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(proposalShed.status, 429, "proposal generation shares the sandbox lane shed");
    assert.equal(proposalShed.headers.get("retry-after"), "1");
    const planShed = await fetch(`${base}/admin/api/assistant/plan`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(planShed.status, 429, "assistant planning shares the sandbox lane shed");
    assert.equal(planShed.headers.get("retry-after"), "1");

    holdLatch.release?.();
    assert.equal((await first).status, 200, "held lanes complete once released");
    assert.equal((await second).status, 200);
    const after = await fetch(`${base}/admin/api/sandbox`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [branch("after", "plain again")] })
    });
    assert.equal(after.status, 200, "the shed releases once the in-flight lanes finish");
  } finally {
    holdLatch.release?.();
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
