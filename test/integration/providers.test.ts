import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

test("multi-provider inference and credits keep credentials and model IDs separated", async () => {
  const inference: Array<{ url: string; authorization: string | undefined; apiKey: string | undefined; anthropicVersion: string | undefined; model: unknown }> = [];
  const openRouterArenaUserAgents: string[] = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === "/agent/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        model_name: "agent-model", supported_endpoint_types: ["openai"], model_ratio: 1, completion_ratio: 1
      }] })); return;
    }
    if (request.url === "/openrouter/v1/models?output_modalities=all") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        id: "vendor/or-model", name: "OR Model", architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" }
      }] })); return;
    }
    if (request.url === "/generic/v1/models") {
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "local-model" }] })); return;
    }
    if (request.url === "/requesty/v1/models") {
      assert.equal(request.headers.authorization, "Bearer requesty-secret");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "vendor/rq-model", type: "chat" }] })); return;
    }
    if (request.url === "/openrouter/v1/key") {
      assert.equal(request.headers.authorization, "Bearer openrouter-secret");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { usage: 2, limit: 10 } })); return;
    }
    if (request.url === "/openrouter/v1/credits") {
      assert.equal(request.headers.authorization, "Bearer management-secret");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { total_credits: 20, total_usage: 3 } })); return;
    }
    if (request.url === "/management/v1/manage/org") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ balance: 7 })); return;
    }
    if (request.url === "/management/v1/manage/apikey/self") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ monthly_spend: 1, monthly_limit: 5 })); return;
    }
    if (request.url === "/openrouter/v1/chat/completions" || request.url === "/requesty/v1/messages" || request.url === "/generic/v1/chat/completions") {
      const payload = await requestBody(request);
      if (request.url === "/openrouter/v1/chat/completions" && payload.stream === true) {
        openRouterArenaUserAgents.push(String(request.headers["user-agent"] || ""));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "arena", object: "chat.completion.chunk", model: payload.model, choices: [{ index: 0, delta: { content: "arena-ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "arena", object: "chat.completion.chunk", model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      inference.push({ url: request.url, authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
        anthropicVersion: request.headers["anthropic-version"] as string | undefined, model: payload.model });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url.endsWith("messages")) response.end(JSON.stringify({ id: "m", type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2, output_tokens: 1, cost: 0.004 } }));
      else response.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.003 } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-providers-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(proxyPort), DATA_DIR: dataDir, PROXY_API_KEY: "local",
      AGENTROUTER_API_KEY: "agent-secret", AGENTROUTER_BASE_URL: `${root}/agent`,
      OPENROUTER_API_KEY: "openrouter-secret", OPENROUTER_MANAGEMENT_KEY: "management-secret", OPENROUTER_BASE_URL: `${root}/openrouter/v1`,
      REQUESTY_API_KEY: "requesty-secret", REQUESTY_BASE_URL: `${root}/requesty/v1`, REQUESTY_MANAGEMENT_BASE_URL: `${root}/management`
      ,GENERIC_OPENAI_BASE_URL: `${root}/generic/v1`, GENERIC_OPENAI_AUTH: "none", GENERIC_OPENAI_ALLOW_PRIVATE: "true"
    }
  });
  try {
    await ready(child);
    const models = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { headers: { authorization: "Bearer local" } }).then((r) => r.json()) as { data: Array<{ id: string; owned_by: string }> };
    assert(models.data.some((model) => model.id === "openrouter:vendor/or-model" && model.owned_by === "openrouter"));
    assert(models.data.some((model) => model.id === "requesty:vendor/rq-model" && model.owned_by === "requesty"));
    assert(models.data.some((model) => model.id === "generic:local-model" && model.owned_by === "generic"));

    const enabled = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledExternalModels: ["openrouter:vendor/or-model", "requesty:vendor/rq-model", "generic:local-model"] })
    });
    assert.equal(enabled.status, 200);

    const openRouter = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, { method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json", "x-api-key": "client-secret" },
      body: JSON.stringify({ model: "openrouter:vendor/or-model", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(openRouter.headers.get("x-router-provider"), "openrouter");
    assert.equal(openRouter.headers.get("x-router-route"), "openrouter:vendor/or-model");
    await openRouter.text();

    const openRouterArena = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [{ id: "openrouter-arena", model: "openrouter:vendor/or-model", messages: [{ role: "user", content: "Use the OpenCode harness identity" }] }] })
    });
    assert.equal(openRouterArena.status, 200);
    const openRouterArenaPayload = await openRouterArena.json() as { results: Array<{ content: string; error: string | null }> };
    assert.equal(openRouterArenaPayload.results[0]?.content, "arena-ok");
    assert.equal(openRouterArenaPayload.results[0]?.error, null);
    assert.deepEqual(openRouterArenaUserAgents, ["opencode/1.15.13"]);

    const requesty = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: "POST",
      headers: { "x-api-key": "local", "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "requesty:vendor/rq-model", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(requesty.headers.get("x-router-provider"), "requesty");
    await requesty.text();
    const generic = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, { method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "generic:local-model", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(generic.headers.get("x-router-provider"), "generic");
    await generic.text();
    assert.deepEqual(inference, [
      { url: "/openrouter/v1/chat/completions", authorization: "Bearer openrouter-secret", apiKey: undefined, anthropicVersion: undefined, model: "vendor/or-model" },
      { url: "/requesty/v1/messages", authorization: undefined, apiKey: "requesty-secret", anthropicVersion: "2023-06-01", model: "vendor/rq-model" },
      { url: "/generic/v1/chat/completions", authorization: undefined, apiKey: undefined, anthropicVersion: undefined, model: "local-model" }
    ]);

    const credits = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/providers/credits/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }).then((r) => r.json()) as { providers: Array<{ providerId: string; remainingUsd: number | null }> };
    assert.equal(credits.providers.find((item) => item.providerId === "openrouter")?.remainingUsd, 17);
    assert.equal(credits.providers.find((item) => item.providerId === "requesty")?.remainingUsd, 7);
    assert.doesNotMatch(JSON.stringify(credits), /secret/);

    const status = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((r) => r.json()) as { catalog: { providers: unknown[] }; providers: unknown[]; metrics: { recent: Array<{ provider: string; usage: { reportedCostUsd: number; costUsd: number } }> } };
    assert.equal(status.catalog.providers.length, 12);
    assert.equal(status.providers.length, 12);
    assert(status.metrics.recent.some((record) => record.provider === "requesty" && record.usage.costUsd === 0.004));
    assert(status.metrics.recent.some((record) => record.provider === "generic" && record.usage.costUsd === 0.003));
    assert.doesNotMatch(JSON.stringify(status.providers), /secret/);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
