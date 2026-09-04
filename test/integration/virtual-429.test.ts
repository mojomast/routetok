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

test("virtual routes cascade across providers on 429 while explicit routes stay strict", async () => {
  const calls: Array<{ url: string; model: unknown }> = [];
  let rqRateLimited = false;
  let rqServerError = false;
  let agentRateLimited = false;
  let agentServerError = false;
  const upstream = createServer(async (request, response) => {
    if (request.url === "/agent/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1
      }] })); return;
    }
    if (request.url === "/openrouter/v1/models?output_modalities=all") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        id: "vendor/or-a", name: "OR A", architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" }
      }, {
        id: "vendor/or-b", name: "OR B", architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" }
      }] })); return;
    }
    if (request.url === "/requesty/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "vendor/rq", type: "chat" }] })); return;
    }
    if (request.url === "/openrouter/v1/chat/completions") {
      const payload = await requestBody(request);
      calls.push({ url: request.url, model: payload.model });
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
      return;
    }
    if (request.url === "/requesty/v1/chat/completions") {
      const payload = await requestBody(request);
      calls.push({ url: request.url, model: payload.model });
      if (rqServerError) {
        response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "boom", type: "server_error" } }));
      } else if (rqRateLimited) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "rq-ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }
      return;
    }
    if (request.url === "/agent/v1/chat/completions" || request.url === "/agent/chat/completions") {
      const payload = await requestBody(request);
      calls.push({ url: request.url, model: payload.model });
      if (agentServerError) {
        response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "boom", type: "server_error" } }));
      } else if (agentRateLimited) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "agent-ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-virtual429-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], env: isolatedTestEnv({
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
      PROXY_API_KEY: "local", DASHBOARD_TOKEN: "dashboard-secret",
      AGENTROUTER_API_KEY: "agent-secret", AGENTROUTER_BASE_URL: `${root}/agent`,
      OPENROUTER_API_KEY: "openrouter-secret", OPENROUTER_BASE_URL: `${root}/openrouter/v1`,
      REQUESTY_API_KEY: "requesty-secret", REQUESTY_BASE_URL: `${root}/requesty/v1`
    })
  });
  try {
    await ready(child);
    const base = `http://127.0.0.1:${port}`;
    const dashboardHeaders = { "x-dashboard-token": "dashboard-secret" };
    const enabled = await fetch(`${base}/admin/api/config`, {
      method: "PATCH", headers: { ...dashboardHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        openaiOrder: ["openrouter:vendor/or-a", "requesty:vendor/rq", "agent-model"],
        fallbackExplicitModels: true,
        enabledExternalModels: ["openrouter:vendor/or-a", "openrouter:vendor/or-b", "requesty:vendor/rq"]
      })
    });
    assert.equal(enabled.status, 200);

    const proxy = (model: string, content: string) => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content }] })
    });
    const decodeSummary = (response: Response) => JSON.parse(Buffer.from(response.headers.get("x-router-attempt-summary") ?? "", "base64url").toString("utf8")) as { a: Array<{ m: string; s: number; o: string }> };

    rqRateLimited = true;
    const strict = await proxy("requesty:vendor/rq", "explicit routes stay strict");
    assert.equal(strict.status, 429);
    assert.equal(strict.headers.get("x-router-attempts"), "1", "an explicit route must not fan out on 429 even with fallbackExplicitModels enabled");
    assert.equal(strict.headers.get("x-router-route"), "requesty:vendor/rq");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    rqRateLimited = false;
    const explicitOk = await proxy("requesty:vendor/rq", "explicit route healthy");
    assert.equal(explicitOk.status, 200);
    assert.equal(explicitOk.headers.get("x-router-attempts"), "1");
    assert.equal(explicitOk.headers.get("x-router-provider"), "requesty");
    await explicitOk.text();

    const firstHop = await proxy("auto", "continue past the 429");
    assert.equal(firstHop.status, 200);
    assert.equal(firstHop.headers.get("x-router-provider"), "requesty");
    assert.equal(firstHop.headers.get("x-router-route"), "requesty:vendor/rq");
    assert.equal(firstHop.headers.get("x-router-attempts"), "2", "auto cascades from the rate-limited first provider to a different-provider candidate");
    assert.equal((await firstHop.json() as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, "rq-ok");

    rqRateLimited = true;
    const deepCascade = await proxy("auto", "both first providers rate limited");
    assert.equal(deepCascade.status, 200);
    assert.equal(deepCascade.headers.get("x-router-provider"), "agentrouter");
    assert.equal(deepCascade.headers.get("x-router-route"), "agent-model");
    assert.equal(deepCascade.headers.get("x-router-attempts"), "2", "the previously rate-limited provider is suppressed inside its retry window, so the chain runs rq then agent-model");

    agentRateLimited = true;
    const exhausted = await proxy("auto", "everything rate limited");
    assert.equal(exhausted.status, 429);
    assert.equal(exhausted.headers.get("x-router-attempts"), "1", "every remaining candidate is suppressed by its own earlier 429, leaving a single terminal attempt");
    assert.equal(exhausted.headers.get("retry-after"), "1", "the upstream retry-after survives the exhausted virtual chain");
    const summary = decodeSummary(exhausted);
    assert.deepEqual(summary.a.map((item) => item.o), ["rate_limited"]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    rqRateLimited = false;
    agentRateLimited = false;
    rqServerError = true;
    agentServerError = true;
    const transientTail = await proxy("auto", "rate limited then transient failures");
    assert.equal(transientTail.status, 502);
    assert.equal(transientTail.headers.get("x-router-attempts"), "3", "the chain must run every remaining candidate after the 429 hop");
    assert.equal(transientTail.headers.get("x-router-terminal"), "fallback_exhausted");
    assert.equal(transientTail.headers.get("retry-after"), "1", "the retry-after from the rate-limited hop must survive the exhausted chain");
    const transientSummary = decodeSummary(transientTail);
    assert.deepEqual(transientSummary.a.map((item) => item.o), ["rate_limited", "transient_error", "transient_error"]);

    assert.deepEqual(calls.map((call) => call.model), [
      "vendor/rq",
      "vendor/rq",
      "vendor/or-a", "vendor/rq",
      "vendor/rq", "agent-model",
      "agent-model",
      "vendor/or-a", "vendor/rq", "agent-model"
    ]);
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
