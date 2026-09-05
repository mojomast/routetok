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

interface UpstreamHandle {
  root: string;
  inferenceCalls: number;
  close: () => Promise<void>;
}

async function startUpstream(withChat: boolean): Promise<UpstreamHandle> {
  let inferenceCalls = 0;
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1
      }] }));
      return;
    }
    if (withChat && url.pathname === "/v1/chat/completions") {
      inferenceCalls += 1;
      const payload = await requestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "ok", object: "chat.completion", model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ORIGIN-OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 }
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  return {
    root: `http://127.0.0.1:${address.port}`,
    get inferenceCalls() { return inferenceCalls; },
    close: () => new Promise<void>((resolve) => upstream.close(() => resolve()))
  };
}

async function spawnServer(env: NodeJS.ProcessEnv): Promise<{ base: string; child: ChildProcess; dataDir: string }> {
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-origin-gate-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({ HOST: "127.0.0.1", PORT: String(proxyPort), DATA_DIR: dataDir, ...env })
  });
  await waitForReady(child);
  return { base: `http://127.0.0.1:${proxyPort}`, child, dataDir };
}

async function stopServer(child: ChildProcess, dataDir: string, upstream: UpstreamHandle): Promise<void> {
  await stopChild(child);
  await upstream.close();
  await rm(dataDir, { recursive: true, force: true });
}

test("no-credential loopback fallback rejects cross-origin browsers on models, metrics, admin, and inference", async () => {
  const upstream = await startUpstream(true);
  const { base, child, dataDir } = await spawnServer({
    AGENTROUTER_API_KEY: "agent-secret",
    AGENTROUTER_BASE_URL: upstream.root
  });
  const proxyPort = new URL(base).port;
  const sameOrigin = `http://127.0.0.1:${proxyPort}`;
  try {
    await fetch(`${base}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openaiOrder: ["agent-model"] })
    }).then((r) => { assert.equal(r.status, 200); return r.text(); });

    const modelsWithoutOrigin = await fetch(`${base}/v1/models`);
    assert.equal(modelsWithoutOrigin.status, 200, "loopback model listing without an Origin header stays allowed");
    assert.equal(modelsWithoutOrigin.headers.get("x-content-type-options"), "nosniff", "JSON responses must carry nosniff");

    const modelsSameOrigin = await fetch(`${base}/v1/models`, { headers: { origin: sameOrigin } });
    assert.equal(modelsSameOrigin.status, 200, "same-origin loopback model listing stays allowed");

    const modelsLocalhostOrigin = await fetch(`${base}/v1/models`, { headers: { origin: `http://localhost:${proxyPort}` } });
    assert.equal(modelsLocalhostOrigin.status, 200, "localhost is an accepted loopback origin");

    for (const foreignOrigin of [
      `http://127.0.0.1:${Number(proxyPort) + 1}`,
      "http://127.0.0.2:8787",
      "http://evil.example",
      "https://evil.example",
      "not a url"
    ]) {
      const response = await fetch(`${base}/v1/models`, { headers: { origin: foreignOrigin } });
      assert.equal(response.status, 403, `foreign Origin ${JSON.stringify(foreignOrigin)} must be rejected on GET /v1/models`);
    }

    const metricsWithoutOrigin = await fetch(`${base}/metrics`);
    assert.equal(metricsWithoutOrigin.status, 200);
    const metricsSameOrigin = await fetch(`${base}/metrics`, { headers: { origin: sameOrigin } });
    assert.equal(metricsSameOrigin.status, 200);
    const metricsForeign = await fetch(`${base}/metrics`, { headers: { origin: "http://evil.example" } });
    assert.equal(metricsForeign.status, 403, "foreign Origin must be rejected on GET /metrics");

    const adminForeign = await fetch(`${base}/admin/api/status`, { headers: { origin: "http://evil.example" } });
    assert.equal(adminForeign.status, 403, "foreign Origin must be rejected on /admin/api");
    const adminSameOrigin = await fetch(`${base}/admin/api/status`, { headers: { origin: sameOrigin } });
    assert.equal(adminSameOrigin.status, 200);

    const upstreamCallsBefore = upstream.inferenceCalls;
    const inferenceForeign = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(inferenceForeign.status, 403, "foreign Origin must be rejected before inference dispatch");
    assert.equal(upstream.inferenceCalls, upstreamCallsBefore, "no upstream may be contacted for a rejected cross-origin request");

    const inferenceSameOrigin = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { origin: sameOrigin, "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(inferenceSameOrigin.status, 200);
    const inferenceBody = await inferenceSameOrigin.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(inferenceBody.choices[0]?.message.content, "ORIGIN-OK");

    const anthropicAliasForeign = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "agent-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(anthropicAliasForeign.status, 403, "the legacy /messages alias shares the inference origin gate");
  } finally {
    await stopServer(child, dataDir, upstream);
  }
});

test("configured credentials ignore Origin headers and enforce env-key, managed-key, and wrong-credential auth", async () => {
  const upstream = await startUpstream(false);
  const { base, child, dataDir } = await spawnServer({
    PROXY_API_KEY: "env-key",
    DASHBOARD_TOKEN: "dash-secret",
    AGENTROUTER_API_KEY: "agent-secret",
    AGENTROUTER_BASE_URL: upstream.root
  });
  const proxyPort = new URL(base).port;
  const foreignHeaders = { origin: "http://evil.example" };
  try {
    const created = await fetch(`${base}/admin/api/client-keys`, {
      method: "POST",
      headers: { "x-dashboard-token": "dash-secret", "content-type": "application/json" },
      body: JSON.stringify({ label: "e2e-managed" })
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json() as { key: { id: string }; secret: string };
    const managedKey = createdPayload.secret;

    for (const headers of [
      { authorization: "Bearer env-key" },
      { authorization: `Bearer ${managedKey}` },
      { "x-api-key": managedKey }
    ]) {
      const response = await fetch(`${base}/v1/models`, { headers });
      assert.equal(response.status, 200, "valid env-key or managed-key credentials must list models");
    }

    const anthropicManaged = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${managedKey}`, "anthropic-version": "2023-06-01" }
    });
    assert.equal(anthropicManaged.status, 200);

    const modelsForeignOrigin = await fetch(`${base}/v1/models`, { headers: { ...foreignHeaders, authorization: "Bearer env-key" } });
    assert.equal(modelsForeignOrigin.status, 200, "the Origin header is ignored once credentials are configured");

    const wrongModels = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer wrong-key" } });
    assert.equal(wrongModels.status, 401);
    const wrongAnthropic = await fetch(`${base}/v1/models`, {
      headers: { authorization: "Bearer wrong-key", "anthropic-version": "2023-06-01" }
    });
    assert.equal(wrongAnthropic.status, 401);
    const anthropicShape = await wrongAnthropic.json() as { type?: string; error?: { type?: string } };
    assert.equal(anthropicShape.type, "error");
    assert.equal(anthropicShape.error?.type, "authentication_error");

    const unauthenticatedModels = await fetch(`${base}/v1/models`);
    assert.equal(unauthenticatedModels.status, 401, "no loopback fallback may exist once a credential is configured");

    const inferenceWrong = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(inferenceWrong.status, 401);

    const metricsWrong = await fetch(`${base}/metrics`, { headers: { "x-dashboard-token": "wrong" } });
    assert.equal(metricsWrong.status, 401);
    const metricsNone = await fetch(`${base}/metrics`);
    assert.equal(metricsNone.status, 401);
    const metricsValid = await fetch(`${base}/metrics`, { headers: { "x-dashboard-token": "dash-secret", ...foreignHeaders } });
    assert.equal(metricsValid.status, 200, "a valid dashboard credential passes even with a foreign Origin header");
    const metricsBody = await metricsValid.text();
    assert.match(metricsBody, /# HELP routetok_requests_total/);
    assert.match(metricsBody, /# HELP agentrouter_router_requests_total/);

    const adminWrong = await fetch(`${base}/admin/api/status`, { headers: { "x-dashboard-token": "wrong" } });
    assert.equal(adminWrong.status, 401);
    const adminValid = await fetch(`${base}/admin/api/status`, { headers: { "x-dashboard-token": "dash-secret" } });
    assert.equal(adminValid.status, 200);

    const revoked = await fetch(`${base}/admin/api/client-keys/${createdPayload.key.id}`, {
      method: "DELETE",
      headers: { "x-dashboard-token": "dash-secret" }
    });
    assert.equal(revoked.status, 200);
    const afterRevoke = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${managedKey}` } });
    assert.equal(afterRevoke.status, 401, "revoking a managed key must invalidate it immediately");
    const adminList = await fetch(`${base}/admin/api/client-keys`, { headers: { "x-dashboard-token": "dash-secret" } });
    assert.equal(adminList.status, 200);
    const adminListPayload = await adminList.json() as { keys: Array<{ id: string }>; environmentKeyConfigured: boolean };
    assert.ok(!adminListPayload.keys.some((key) => key.id === createdPayload.key.id));
    assert.equal(adminListPayload.environmentKeyConfigured, true);
  } finally {
    await stopServer(child, dataDir, upstream);
  }
});
