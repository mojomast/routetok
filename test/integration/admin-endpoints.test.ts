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

function sseChunk(id: string, model: string, delta: string, done = false): string {
  const line = JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: done ? "stop" : null }] });
  return `data: ${line}\n\n`;
}

test("admin diagnostic endpoints are reachable over HTTP with dashboard auth", async () => {
  const inferenceCalls: Array<{ path: string; model: string; authorization: string | undefined; stream: boolean }> = [];
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1
      }] })); return;
    }
    if (url.pathname === "/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fast-model", active: true, type: "chat", pricing: { input: 0.2, output: 0.8 } }] })); return;
    }
    if (url.pathname === "/requesty/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "vendor/rq-model", type: "chat", pricing: { input: 0.000002, output: 0.000004 } }] })); return;
    }
    if (url.pathname === "/openrouter/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "vendor/or-model", name: "OR Model", pricing: { prompt: "0.000001", completion: "0.000002" } }] })); return;
    }
    if (url.pathname === "/management/v1/manage/org") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ balance: 7 }));
      return;
    }
    if (url.pathname === "/management/v1/manage/apikey/self") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ monthly_spend: 1, monthly_limit: 5 }));
      return;
    }
    const chatPath = url.pathname.endsWith("/chat/completions");
    if (!chatPath) {
      response.writeHead(404).end();
      return;
    }
    if (url.pathname.startsWith("/requesty/") &&
        !["Bearer stored-secret", "Bearer requesty-secret"].includes(request.headers.authorization ?? "")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "requesty credentials missing or tombstoned" } }));
      return;
    }
    const payload = await requestBody(request);
    inferenceCalls.push({
      path: url.pathname,
      model: String(payload.model),
      authorization: request.headers.authorization as string | undefined,
      stream: payload.stream === true
    });
    const marker = JSON.stringify(payload.messages ?? []);
    if (payload.model === "agent-model" && marker.includes("trigger-proposal")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const proposal = JSON.stringify({ summary: "Raise the attempt budget", rationale: "Observed transient upstream failures", patch: { maxAttempts: 3 } });
      response.write(sseChunk("p1", "agent-model", `{"summary":"Raise the attempt budget","rationale":"Observed transient upst`, false));
      response.write(sseChunk("p2", "agent-model", `ream failures","patch":{"maxAttempts":3}}`, false));
      response.write(sseChunk("p3", "agent-model", "", true));
      response.end("data: [DONE]\n\n");
      return;
    }
    if (payload.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk("s1", String(payload.model), "streamed-ok", false));
      response.write(sseChunk("s2", String(payload.model), "", true));
      response.end("data: [DONE]\n\n");
      return;
    }
    if (marker.includes("trigger-total-fail")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    if (payload.model === "agent-model" && marker.includes("trigger-fail")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "ok", object: "chat.completion", model: payload.model, choices: [{ index: 0, message: { role: "assistant", content: "FALLBACK-OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.001 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-admin-endpoints-"));
  const dashboardHeaders = { "x-dashboard-token": "dashboard-secret" };
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      PROXY_API_KEY: "local",
      DASHBOARD_TOKEN: "dashboard-secret",
      AGENTROUTER_API_KEY: "agent-secret",
      AGENTROUTER_BASE_URL: root,
      GROQ_API_KEY: "groq-secret",
      GROQ_BASE_URL: root,
      KIMI_CODING_API_KEY: "kimi-secret",
      KIMI_CODING_BASE_URL: `${root}/kimi/v1`,
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENROUTER_BASE_URL: `${root}/openrouter/v1`,
      REQUESTY_API_KEY: "requesty-secret",
      REQUESTY_BASE_URL: `${root}/requesty/v1`,
      REQUESTY_MANAGEMENT_BASE_URL: `${root}/management`
    })
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  try {
    await waitForReady(child);

    const routed = await fetch(`${base}/admin/api/config`, {
      method: "PATCH",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        enabledExternalModels: ["groq:fast-model", "requesty:vendor/rq-model", "openrouter:vendor/or-model"],
        openaiOrder: ["agent-model", "groq:fast-model"],
        fallbackExplicitModels: true
      })
    });
    assert.equal(routed.status, 200);

    const failing = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "trigger-fail please" }] })
    });
    assert.equal(failing.status, 200);
    assert.equal(failing.headers.get("x-router-attempts"), "2");
    const attemptsHeader = failing.headers.get("x-router-attempt-summary") ?? "";
    assert.match(attemptsHeader, /^[A-Za-z0-9_-]+$/);
    const fallbackBody = await failing.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(fallbackBody.choices[0]?.message.content, "FALLBACK-OK");

    const decoded = await fetch(`${base}/admin/api/attempts/decode?header=${encodeURIComponent(attemptsHeader)}`, { headers: dashboardHeaders });
    assert.equal(decoded.status, 200);
    const decodedPayload = await decoded.json() as { ok: true; attempts: Array<{ model: string; outcome: string }>; total: number; truncated: boolean };
    assert.equal(decodedPayload.ok, true);
    assert.equal(decodedPayload.total, 2);
    assert.equal(decodedPayload.truncated, false);
    assert.deepEqual(decodedPayload.attempts.map((attempt) => attempt.model), ["agent-model", "groq:fast-model"]);
    assert.deepEqual(decodedPayload.attempts.map((attempt) => attempt.outcome), ["transient_error", "success"]);

    const missingHeader = await fetch(`${base}/admin/api/attempts/decode`, { headers: dashboardHeaders });
    assert.equal(missingHeader.status, 400);
    const oversizedHeader = await fetch(`${base}/admin/api/attempts/decode?header=${"x".repeat(9000)}`, { headers: dashboardHeaders });
    assert.equal(oversizedHeader.status, 400);

    const unauthorized = await fetch(`${base}/admin/api/attempts/decode?header=abc`);
    assert.equal(unauthorized.status, 401);

    const credits = await fetch(`${base}/admin/api/providers/credits`, { headers: dashboardHeaders });
    assert.equal(credits.status, 200);
    const creditsPayload = await credits.json() as { providers: Array<{ providerId: string; remainingUsd: number | null }> };
    assert.ok(creditsPayload.providers.some((provider) => provider.providerId === "openrouter"));
    assert.ok(creditsPayload.providers.some((provider) => provider.providerId === "groq" && provider.remainingUsd === null));
    const filteredCredits = await fetch(`${base}/admin/api/providers/credits?provider=openrouter`, { headers: dashboardHeaders }).then((r) => r.json()) as { providers: Array<{ providerId: string }> };
    assert.ok(filteredCredits.providers.every((provider) => provider.providerId === "openrouter"));
    const unknownCredits = await fetch(`${base}/admin/api/providers/credits?provider=not-a-provider`, { headers: dashboardHeaders });
    assert.equal(unknownCredits.status, 400);

    const stored = await fetch(`${base}/admin/api/providers/requesty/credentials/apiKey`, {
      method: "PUT",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ value: "stored-secret" })
    });
    assert.equal(stored.status, 200);
    const storedPayload = await stored.json() as { committed: boolean; refresh: { ok: boolean; errors: string[] } };
    assert.equal(storedPayload.committed, true);
    assert.equal(storedPayload.refresh.ok, true, `requesty credential store must refresh cleanly: ${JSON.stringify(storedPayload.refresh.errors)}`);

    const storedSecretCall = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "requesty:vendor/rq-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(storedSecretCall.status, 200);
    await storedSecretCall.text();
    assert.equal(inferenceCalls.at(-1)?.authorization, "Bearer stored-secret", "the stored credential must reach the upstream");

    const removed = await fetch(`${base}/admin/api/providers/requesty/credentials/apiKey`, {
      method: "DELETE",
      headers: dashboardHeaders
    });
    assert.equal(removed.status, 200);
    const removedPayload = await removed.json() as { provider: { providerId: string }; committed: boolean; refresh: { ok: boolean } };
    assert.equal(removedPayload.committed, true);
    assert.equal(removedPayload.provider.providerId, "requesty");
    assert.equal(removedPayload.refresh.ok, true, "deleting a stored key must leave a refreshable tombstoned provider");

    const modelsAfterDelete = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local" } }).then((r) => r.json()) as { data: Array<{ id: string }> };
    assert.ok(!modelsAfterDelete.data.some((model) => model.id.startsWith("requesty:")), "a tombstoned provider must no longer contribute catalog models");
    const callsBeforeAfterDelete = inferenceCalls.length;
    const afterDeleteCall = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "requesty:vendor/rq-model", messages: [{ role: "user", content: "trigger-total-fail tombstoned" }] })
    });
    assert.equal(afterDeleteCall.status, 500, "the tombstoned chain must end in the last upstream failure status");
    const afterDeleteError = await afterDeleteCall.json() as { error: { code: string } };
    assert.equal(afterDeleteError.error.code, "fallback_exhausted");
    assert.equal(afterDeleteCall.headers.get("x-router-attempts"), "2");
    const afterDeleteCalls = inferenceCalls.slice(callsBeforeAfterDelete);
    assert.ok(!afterDeleteCalls.some((call) => call.path.startsWith("/requesty/")), "no requesty upstream may be contacted after the credential deletion");

    const restored = await fetch(`${base}/admin/api/providers/requesty/credentials/apiKey`, {
      method: "PUT",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ value: "requesty-secret" })
    });
    assert.equal(restored.status, 200);

    const refreshed = await fetch(`${base}/admin/api/catalog/refresh`, { method: "POST", headers: dashboardHeaders });
    assert.equal(refreshed.status, 200);
    const refreshedPayload = await refreshed.json() as { catalog: { source: string }; models: Array<{ id: string }> };
    assert.deepEqual(refreshedPayload.models.map((model) => model.id).filter((id) => id === "agent-model" || id === "groq:fast-model").sort(), ["agent-model", "groq:fast-model"]);
    const unknownRefresh = await fetch(`${base}/admin/api/catalog/refresh?provider=not-a-provider`, { method: "POST", headers: dashboardHeaders });
    assert.equal(unknownRefresh.status, 400);

    const simulate = await fetch(`${base}/admin/api/route/simulate?model=auto&protocol=openai&tools=true`, { headers: dashboardHeaders });
    assert.equal(simulate.status, 200);
    const simulatePayload = await simulate.json() as { model: string; protocol: string; candidates: Array<{ id: string; eligible: boolean; rank: number }> };
    assert.equal(simulatePayload.model, "auto");
    assert.equal(simulatePayload.candidates[0]?.id, "agent-model");
    assert.equal(simulatePayload.candidates[0]?.eligible, true);
    assert.equal(simulatePayload.candidates[1]?.id, "groq:fast-model");
    const simulateMissing = await fetch(`${base}/admin/api/route/simulate`, { headers: dashboardHeaders });
    assert.equal(simulateMissing.status, 400);
    const simulateBadProtocol = await fetch(`${base}/admin/api/route/simulate?model=auto&protocol=ftp`, { headers: dashboardHeaders });
    assert.equal(simulateBadProtocol.status, 400);

    const visibility = await fetch(`${base}/admin/api/models/visibility`, { headers: dashboardHeaders });
    assert.equal(visibility.status, 200);
    const visibilityPayload = await visibility.json() as { models: Array<{ id: string }> };
    assert.ok(visibilityPayload.models.some((model) => model.id === "agent-model"));
    assert.ok(visibilityPayload.models.some((model) => model.id === "groq:fast-model"));

    const beforeProposal = await fetch(`${base}/admin/api/status`, { headers: dashboardHeaders }).then((r) => r.json()) as { configRevision: string; config: { maxAttempts: number } };
    assert.equal(beforeProposal.config.maxAttempts, 4);
    const proposal = await fetch(`${base}/admin/api/config/proposals/generate`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", prompt: "Please trigger-proposal with a higher attempt budget" })
    });
    assert.equal(proposal.status, 200);
    const proposalPayload = await proposal.json() as { advisorModel: string; proposal: { id: string; patch: { maxAttempts: number }; changes: Array<{ field: string }> } };
    assert.equal(proposalPayload.advisorModel, "agent-model");
    assert.equal(proposalPayload.proposal.patch.maxAttempts, 3);
    assert.ok(proposalPayload.proposal.changes.some((change) => change.field === "maxAttempts"));
    const afterProposal = await fetch(`${base}/admin/api/status`, { headers: dashboardHeaders }).then((r) => r.json()) as { configRevision: string; config: { maxAttempts: number } };
    assert.equal(afterProposal.configRevision, beforeProposal.configRevision, "generating a proposal must not apply it");
    assert.equal(afterProposal.config.maxAttempts, 4);

    const proposalValidationError = await fetch(`${base}/admin/api/config/proposals/generate`, {
      method: "POST",
      headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", prompt: "" })
    });
    assert.equal(proposalValidationError.status, 400);
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
