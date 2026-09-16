import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv, stopChild, waitFor } from "../support/process.js";

interface Call { url: string; authorization: string | undefined; headers: IncomingHttpHeaders; body: Record<string, unknown> | null }

async function readRequest(request: IncomingMessage): Promise<{ text: string; body: Record<string, unknown> | null }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = text ? JSON.parse(text) as unknown : null;
    return { text, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
  } catch {
    return { text, body: null };
  }
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

function codexIdToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("GitHub Copilot device OAuth connects, refreshes, and authenticates inference", async () => {
  const calls: Call[] = [];
  const upstream = createServer(async (request, response) => {
    const { body } = await readRequest(request);
    calls.push({ url: request.url ?? "", authorization: request.headers.authorization, headers: request.headers, body });
    if (request.url === "/login/device/code") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        device_code: "device-123", user_code: "TEST-CODE", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 120
      }));
      return;
    }
    if (request.url === "/login/oauth/access_token") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "github-oauth-token" }));
      return;
    }
    if (request.url === "/copilot_internal/v2/token") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        token: "tid=1;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;", expires_at: Math.floor(Date.now() / 1000) + 3600
      }));
      return;
    }
    if (request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        id: "copilot-gpt", name: "Copilot GPT", model_picker_enabled: true, policy: { state: "enabled" },
        capabilities: { supports: { tool_calls: true } }
      }] }));
      return;
    }
    if (request.url === "/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "chatcmpl-copilot", choices: [{ message: { role: "assistant", content: "copilot-ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 }
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
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-oauth-copilot-"));
  const dashboardHeaders = { "x-dashboard-token": "dashboard-secret", "content-type": "application/json" };
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], env: isolatedTestEnv({
      HOST: "127.0.0.1", PORT: String(proxyPort), DATA_DIR: dataDir, PROXY_API_KEY: "local", DASHBOARD_TOKEN: "dashboard-secret",
      COPILOT_OAUTH_BASE_URL: root, COPILOT_API_BASE_URL: root, COPILOT_INFERENCE_BASE_URL: root
    })
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  try {
    await ready(child);
    const started = await fetch(`${base}/admin/api/providers/github-copilot/oauth/start`, {
      method: "POST", headers: dashboardHeaders, body: JSON.stringify({ method: "device" })
    });
    assert.equal(started.status, 202);
    const startPayload = await started.json() as { started: { method: string; userCode: string | null; url: string } };
    assert.equal(startPayload.started.method, "device");
    assert.equal(startPayload.started.userCode, "TEST-CODE");

    const connected = await waitFor(
      () => fetch(`${base}/admin/api/providers/github-copilot/oauth/status`, { headers: dashboardHeaders }).then((r) => r.json()) as Promise<{ flow: { state: string } }>,
      (payload) => payload.flow.state === "connected",
      10_000
    );
    assert.equal(connected.flow.state, "connected");

    const status = await fetch(`${base}/admin/api/status`, { headers: { "x-dashboard-token": "dashboard-secret" } }).then((r) => r.json());
    assert.doesNotMatch(JSON.stringify(status), /github-oauth-token|tid=1;exp=|codex-access-token/);

    const config = await fetch(`${base}/admin/api/config`, {
      method: "PATCH", headers: dashboardHeaders, body: JSON.stringify({ enabledExternalModels: ["github-copilot:copilot-gpt"] })
    });
    assert.equal(config.status, 200);
    await waitFor(
      () => fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local" } }).then((r) => r.json()) as Promise<{ data: Array<{ id: string }> }>,
      (payload) => payload.data.some((model) => model.id === "github-copilot:copilot-gpt"),
      5_000
    );

    const inference = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "github-copilot:copilot-gpt", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(inference.status, 200);
    assert.equal(inference.headers.get("x-router-provider"), "github-copilot");
    const payload = await inference.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(payload.choices[0]?.message.content, "copilot-ok");

    const chatCall = calls.find((call) => call.url === "/chat/completions");
    assert.ok(chatCall, "the Copilot inference endpoint must be reached without a /v1 prefix");
    assert.equal(chatCall.authorization, "Bearer tid=1;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;");
    assert.equal(chatCall.headers["copilot-integration-id"], "vscode-chat");
    assert.equal(chatCall.headers["user-agent"], "GitHubCopilotChat/0.35.0");
    assert.equal(chatCall.headers["x-github-api-version"], "2026-06-01");
    assert.equal(chatCall.body?.model, "copilot-gpt");

    const disconnected = await fetch(`${base}/admin/api/providers/github-copilot/oauth`, {
      method: "DELETE", headers: { "x-dashboard-token": "dashboard-secret" }
    });
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json() as { disconnected: boolean }).disconnected, true);
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OpenAI Codex browser OAuth connects and routes Responses with the account header", async () => {
  const calls: Call[] = [];
  const upstream = createServer(async (request, response) => {
    const { body } = await readRequest(request);
    calls.push({ url: request.url ?? "", authorization: request.headers.authorization, headers: request.headers, body });
    if (request.url === "/oauth/token") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        access_token: "codex-access-token", refresh_token: "codex-refresh-token", expires_in: 3600, id_token: codexIdToken("acct_test")
      }));
      return;
    }
    if (request.url === "/responses") {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "codex test stop" } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const proxyPort = await freePort();
  const redirectPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-oauth-codex-"));
  const dashboardHeaders = { "x-dashboard-token": "dashboard-secret", "content-type": "application/json" };
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], env: isolatedTestEnv({
      HOST: "127.0.0.1", PORT: String(proxyPort), DATA_DIR: dataDir, PROXY_API_KEY: "local", DASHBOARD_TOKEN: "dashboard-secret",
      CODEX_OAUTH_BASE_URL: root, CODEX_API_BASE_URL: root, CODEX_OAUTH_REDIRECT_PORT: String(redirectPort),
      ROUTETOK_OAUTH_CALLBACK_HOST: "127.0.0.1"
    })
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  try {
    await ready(child);
    const started = await fetch(`${base}/admin/api/providers/openai-codex/oauth/start`, {
      method: "POST", headers: dashboardHeaders, body: JSON.stringify({ method: "browser" })
    });
    assert.equal(started.status, 202);
    const startPayload = await started.json() as { started: { url: string; method: string } };
    assert.equal(startPayload.started.method, "browser");
    const state = new URL(startPayload.started.url).searchParams.get("state");
    assert.ok(state);

    const callback = await fetch(`http://127.0.0.1:${redirectPort}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 200);

    const connected = await waitFor(
      () => fetch(`${base}/admin/api/providers/openai-codex/oauth/status`, { headers: dashboardHeaders }).then((r) => r.json()) as Promise<{ oauth: { accountId: string | null }; flow: { state: string } }>,
      (payload) => payload.flow.state === "connected",
      10_000
    );
    assert.equal(connected.oauth.accountId, "acct_test");

    const config = await fetch(`${base}/admin/api/config`, {
      method: "PATCH", headers: dashboardHeaders, body: JSON.stringify({ enabledExternalModels: ["openai-codex:gpt-5.3-codex"] })
    });
    assert.equal(config.status, 200);
    await waitFor(
      () => fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local" } }).then((r) => r.json()) as Promise<{ data: Array<{ id: string }> }>,
      (payload) => payload.data.some((model) => model.id === "openai-codex:gpt-5.3-codex"),
      5_000
    );

    const nonStream = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai-codex:gpt-5.3-codex", input: "hello", stream: false })
    });
    assert.equal(nonStream.status, 400);
    assert.match(JSON.stringify(await nonStream.json()), /stream/);

    const responses = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai-codex:gpt-5.3-codex", input: "hello", stream: true })
    });
    assert.equal(responses.status, 400);

    const call = calls.find((entry) => entry.url === "/responses");
    assert.ok(call, "Codex requests must be rewritten to the /responses endpoint");
    assert.equal(call.authorization, "Bearer codex-access-token");
    assert.equal(call.headers["chatgpt-account-id"], "acct_test");
    assert.equal(call.body?.model, "gpt-5.3-codex");
    assert.equal(call.body?.store, false);
    assert.equal(call.body?.stream, true);
    assert.equal(typeof call.body?.instructions, "string");
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
