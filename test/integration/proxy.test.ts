import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface CapturedCall {
  model: string;
  authorization: string | undefined;
  userAgent: string | undefined;
  clientApiKey: string | undefined;
  messages: unknown[];
  maxTokens: unknown;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function waitForReady(child: ChildProcess): Promise<void> {
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
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Proxy exited before startup with ${code}: ${output}`));
    });
  });
}

test("proxy preserves client identity, replaces credentials, and falls back before output", async () => {
  const calls: CapturedCall[] = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === "/api/pricing") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        success: true,
        data: [
          {
            model_name: "bad-model",
            supported_endpoint_types: ["openai"],
            model_ratio: 1,
            completion_ratio: 3
          },
          {
            model_name: "good-model",
            supported_endpoint_types: ["openai"],
            model_ratio: 4,
            completion_ratio: 5
          }
        ]
      }));
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    const payload = await body(request);
    calls.push({
      model: String(payload.model),
      authorization: request.headers.authorization,
      userAgent: request.headers["user-agent"],
      clientApiKey: typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined,
      messages: Array.isArray(payload.messages) ? payload.messages : []
      ,maxTokens: payload.max_tokens
    });
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (messages.some((message) => JSON.stringify(message).includes("trigger-sensitive-filter"))) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "sensitive words detected",
          type: "new_api_error",
          code: "sensitive_words_detected"
        }
      }));
      return;
    }
    if (payload.model === "bad-model" && messages.some((message) => JSON.stringify(message).includes("trigger-budget-pool"))) {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Budget pool quota has been exhausted. Please select another budget pool.",
          type: "bad_response_status_code",
          code: "bad_response_status_code"
        }
      }));
      return;
    }
    if (payload.model === "bad-model" && payload.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const heartbeat = setInterval(() => response.write(": ping\n\n"), 50);
      request.once("close", () => clearInterval(heartbeat));
      response.once("close", () => clearInterval(heartbeat));
      return;
    }
    if (payload.model === "good-model" && payload.stream === true && messages.some((message) => JSON.stringify(message).includes("bounded comparison planner"))) {
      const plan = JSON.stringify({ mode: "design", models: ["good-model"], prompt: "Design a synthetic status card.", parameters: { maxTokens: 2048, temperature: 0.4 }, rationale: "The selected model supports the requested design task." }).replace(/}$/, ",}");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "planner", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: { content: plan }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "planner", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (payload.model === "good-model" && payload.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write([
        "data: null",
        "",
        'event: billing_summary\ndata: {"object":"billing.summary","billing":{"request":{"tokens":{"input_tokens":2,"output_tokens":13,"cache_read_input_tokens":18262,"cache_creation_input_tokens":115},"cost_cny":{"total":"0.1278"}}}}',
        "",
        'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","model":"good-model","choices":[{"index":0,"delta":{"content":"FALLBACK-OK"},"finish_reason":null}]}',
        "",
        ""
      ].join("\n"));
      setTimeout(() => response.end([
        'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","model":"good-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n")), 100);
      return;
    }
    if (payload.model === "bad-model") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("null");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "good-model",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
    }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const proxyPort = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-test-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      AGENTROUTER_API_KEY: "test-upstream-key",
      AGENTROUTER_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      PROXY_API_KEY: "local-client-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForReady(child);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "user-agent": "opencode-real-client/1.2.3",
        "x-api-key": "must-not-reach-upstream"
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Reply OK" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-router-model"), "good-model");
    assert.equal(response.headers.get("x-router-attempts"), "2");
    const payload = await response.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(payload.choices[0]?.message.content, "OK");

    assert.deepEqual(calls.map((call) => call.model), ["bad-model", "good-model"]);
    assert(calls.every((call) => call.authorization === "Bearer test-upstream-key"));
    assert(calls.every((call) => call.userAgent === "opencode-real-client/1.2.3"));
    assert(calls.every((call) => call.clientApiKey === undefined));

    const status = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`);
    assert.equal(status.status, 200);
    const dashboard = await status.json() as {
      metrics: {
        totals: { requests: number; fallbacks: number };
        recent: Array<{ id: string }>;
      };
    };
    assert.equal(dashboard.metrics.totals.requests, 1);
    assert.equal(dashboard.metrics.totals.fallbacks, 1);
    assert.doesNotMatch(JSON.stringify(dashboard), /Reply OK/);
    assert.doesNotMatch(JSON.stringify(dashboard), /"series"/);

    const initialHistoryResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/history?limit=100`);
    assert.equal(initialHistoryResponse.status, 200);
    const initialHistory = await initialHistoryResponse.json() as {
      retained: number;
      samples: Array<{ requestId: string; durationMs: number; inputTokens: number; outputTokens: number }>;
    };
    assert.equal(initialHistory.retained, 1);
    assert.equal(initialHistory.samples.length, 1);
    assert.equal(initialHistory.samples[0]?.requestId, dashboard.metrics.recent[0]?.id);
    assert((initialHistory.samples[0]?.durationMs ?? -1) >= 0);

    const retainedContent = await fetch(
      `http://127.0.0.1:${proxyPort}/admin/api/requests/${dashboard.metrics.recent[0]?.id}/content`
    );
    assert.equal(retainedContent.status, 200);
    const retainedPayload = await retainedContent.json() as { body: { messages?: unknown[] } };
    assert.equal(retainedPayload.body.messages?.length, 1);

    const dashboardPage = await fetch(`http://127.0.0.1:${proxyPort}/dashboard`);
    assert.equal(dashboardPage.status, 200);
    assert.match(await dashboardPage.text(), /ROUTETOK<span>\/01<\/span>/);

    const openAiModels = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { "x-api-key": "local-client-key" }
    });
    const openAiCatalog = await openAiModels.json() as { object?: string };
    assert.equal(openAiCatalog.object, "list");

    const anthropicModels = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: {
        "x-api-key": "local-client-key",
        "anthropic-version": "2023-06-01"
      }
    });
    const anthropicCatalog = await anthropicModels.json() as { has_more?: boolean };
    assert.equal(anthropicCatalog.has_more, false);

    const customCascadeConfig = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ customCascades: [{ name: "test-cascade", members: ["bad-model", "good-model"] }] })
    });
    assert.equal(customCascadeConfig.status, 200);
    const advertised = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { headers: { authorization: "Bearer local-client-key" } }).then((response) => response.json()) as { data: Array<{ id: string; owned_by: string }> };
    assert(advertised.data.some((model) => model.id === "test-cascade" && model.owned_by === "routetok"));
    const customCascade = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer local-client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-cascade", messages: [{ role: "user", content: "Use custom cascade" }] })
    });
    assert.equal(customCascade.status, 200);
    assert.equal(customCascade.headers.get("x-router-model"), "good-model");
    assert.equal(customCascade.headers.get("x-router-attempts"), "2");
    await customCascade.text();

    await fetch(`http://127.0.0.1:${proxyPort}/admin/api/circuits/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const configured = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstEventTimeoutMs: 1_000 })
    });
    assert.equal(configured.status, 200);

    const abortController = new AbortController();
    const cancelledRequest = fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "user-agent": "opencode-real-client/1.2.3"
      },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "Cancel this request" }]
      }),
      signal: abortController.signal
    });
    setTimeout(() => abortController.abort(), 100);
    await assert.rejects(cancelledRequest);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelledStatus = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`);
    const cancellationMetrics = await cancelledStatus.json() as {
      metrics: {
        totals: { clientCancellations: number; upstreamAttempts: number };
        recent: Array<{ status: number; attempts: Array<{ outcome: string }> }>;
      };
    };
    assert.equal(cancellationMetrics.metrics.recent[0]?.status, 499);
    assert.equal(cancellationMetrics.metrics.recent[0]?.attempts[0]?.outcome, "cancelled");
    assert.equal(cancellationMetrics.metrics.totals.clientCancellations, 1);

    const streamStarted = Date.now();
    const streamResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "user-agent": "opencode-real-client/1.2.3"
      },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "Reply OK" }]
      })
    });
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("x-router-model"), "good-model");
    assert.equal(streamResponse.headers.get("x-router-attempts"), "2");
    const liveStatus = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`);
    const liveDashboard = await liveStatus.json() as {
      metrics: {
        totals: { requests: number };
        inFlight: Array<{
          phase: string;
          estimatedOutputTokens: number;
          estimatedOutputTokensPerSecond: number | null;
        }>;
      };
    };
    assert.equal(liveDashboard.metrics.inFlight.length, 1);
    assert.equal(liveDashboard.metrics.inFlight[0]?.phase, "streaming");
    assert((liveDashboard.metrics.inFlight[0]?.estimatedOutputTokens ?? 0) > 0);
    assert((liveDashboard.metrics.inFlight[0]?.estimatedOutputTokensPerSecond ?? 0) > 0);
    const lightweightLive = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/live`).then((response) => response.json()) as {
      completedRequests: number;
      inFlight: unknown[];
      recent: unknown[];
    };
    assert.equal(lightweightLive.inFlight.length, 1);
    assert.equal(lightweightLive.completedRequests, liveDashboard.metrics.totals.requests);
    assert(lightweightLive.recent.length > 0);
    const streamText = await streamResponse.text();
    assert.match(streamText, /FALLBACK-OK/);
    assert.doesNotMatch(streamText, /billing\.summary|data: null/);
    assert(Date.now() - streamStarted < 4_000, "heartbeat-only model should not extend its deadline");

    const finalStatus = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`);
    const finalDashboard = await finalStatus.json() as {
      metrics: {
        inFlight: unknown[];
        recent: Array<{
          ttftMs: number | null;
          generationDurationMs: number | null;
          outputTokensPerSecond: number | null;
          attempts: Array<{ firstOutputMs: number | null }>;
          usage: { costCny: number; estimatedCostUsd: number };
        }>;
      };
    };
    assert.equal(finalDashboard.metrics.recent[0]?.usage.costCny, 0.1278);
    assert.equal(finalDashboard.metrics.inFlight.length, 0);
    assert.equal(finalDashboard.metrics.recent[0]?.usage.estimatedCostUsd, 0.074734);
    assert((finalDashboard.metrics.recent[0]?.ttftMs ?? 0) >= 900);
    assert((finalDashboard.metrics.recent[0]?.generationDurationMs ?? 0) >= 20);
    assert((finalDashboard.metrics.recent[0]?.outputTokensPerSecond ?? 0) > 0);
    assert((finalDashboard.metrics.recent[0]?.attempts[1]?.firstOutputMs ?? 0) >= 0);
    const throughputHistory = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/history?limit=1`)
      .then((response) => response.json()) as { samples: Array<{ outputTokensPerSecond: number | null }> };
    assert((throughputHistory.samples[0]?.outputTokensPerSecond ?? 0) > 0);

    await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fallbackExplicitModels: false })
    });
    const normalizedError = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "user-agent": "opencode-real-client/1.2.3"
      },
      body: JSON.stringify({
        model: "bad-model",
        messages: [{ role: "user", content: "Reply OK" }]
      })
    });
    assert.equal(normalizedError.status, 503);
    const normalizedBody = await normalizedError.json() as { error?: unknown };
    assert(normalizedBody.error && typeof normalizedBody.error === "object");

    await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fallbackExplicitModels: true })
    });
    const callsBeforeFilter = calls.length;
    const contentFiltered = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "user-agent": "opencode-real-client/1.2.3"
      },
      body: JSON.stringify({
        model: "bad-model",
        messages: [{ role: "user", content: "trigger-sensitive-filter" }]
      })
    });
    assert.equal(contentFiltered.status, 400);
    const filteredBody = await contentFiltered.json() as { error?: { code?: string } };
    assert.equal(filteredBody.error?.code, "sensitive_words_detected");
    assert.equal(calls.length, callsBeforeFilter + 1, "content filtering must not fan out to fallback models");

    const budgetFallback = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "user-agent": "opencode-real-client/1.2.3"
      },
      body: JSON.stringify({
        model: "bad-model",
        messages: [{ role: "user", content: "trigger-budget-pool" }]
      })
    });
    assert.equal(budgetFallback.status, 200);
    assert.equal(budgetFallback.headers.get("x-router-model"), "good-model");
    assert.equal(budgetFallback.headers.get("x-router-attempts"), "2");

    const sandboxCallsBefore = calls.length;
    const dashboardChat = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [
        { id: "good", model: "good-model", messages: [{ role: "user", content: "Compare this" }] },
        { id: "bad", model: "bad-model", messages: [{ role: "user", content: "Compare this" }] }
      ] })
    });
    assert.equal(dashboardChat.status, 200);
    const sandbox = await dashboardChat.json() as { results: Array<{ requestedModel: string; content: string; error: string | null; metrics: { route: string | null; latencyMs: number } | null }> };
    assert.equal(sandbox.results.length, 2);
    assert.equal(sandbox.results.find((result) => result.requestedModel === "good-model")?.content, "FALLBACK-OK");
    assert.match(sandbox.results.find((result) => result.requestedModel === "bad-model")?.error ?? "", /HTTP 503|No healthy compatible/);
    assert.equal(sandbox.results.find((result) => result.requestedModel === "good-model")?.metrics?.route, "good-model");
    assert((sandbox.results.find((result) => result.requestedModel === "good-model")?.metrics?.latencyMs ?? -1) >= 0);
    const sandboxModelsCalled = calls.slice(sandboxCallsBefore).map((call) => call.model);
    assert.equal(sandboxModelsCalled.filter((model) => model === "good-model").length, 1);
    assert(sandboxModelsCalled.filter((model) => model === "bad-model").length <= 1, "sandbox must never fall back an explicit failed model");
    assert(calls.slice(sandboxCallsBefore).every((call) => call.userAgent === "opencode/1.15.13"), "internal AgentRouter sandbox calls must use the supported OpenCode identity");

    const providerDefault = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [{ id: "default", model: "good-model", parameters: {}, messages: [{ role: "user", content: "Use provider defaults" }] }] })
    });
    assert.equal(providerDefault.status, 200);
    await providerDefault.text();
    assert.equal(calls.at(-1)?.maxTokens, undefined, "provider-default mode must omit max_tokens upstream");

    const designResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "design",
        requests: [{ id: "design", model: "good-model", parameters: { maxTokens: 8192, temperature: 0.7, topP: 0.9 }, messages: [{ role: "user", content: "Design a card" }] }]
      })
    });
    assert.equal(designResponse.status, 200);
    const designCall = calls.at(-1);
    assert.equal((designCall?.messages[0] as { role?: string })?.role, "system");
    assert.match(JSON.stringify(designCall?.messages[0]), /self-contained HTML document/);
    const invalidPurpose = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "shell", requests: [] })
    });
    assert.equal(invalidPurpose.status, 400);

    const planned = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/assistant/plan`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ advisorModel: "good-model", request: "Run a design comparison for a compact status card", modeHint: "design" })
    });
    assert.equal(planned.status, 200);
    const plannedPayload = await planned.json() as { plan: { mode: string; models: string[]; prompt: string; parameters: { maxTokens?: number; temperature?: number }; rationale: string } };
    assert.equal(plannedPayload.plan.mode, "design");
    assert.deepEqual(plannedPayload.plan.models, ["good-model"]);
    assert.equal(plannedPayload.plan.parameters.maxTokens, 2048);
    assert.match(plannedPayload.plan.prompt, /status card/i);

    const beforeProposal = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((response) => response.json()) as {
      configRevision: string;
      config: { maxAttempts: number };
    };
    const validated = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config/proposals/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: beforeProposal.configRevision, patch: { maxAttempts: 2 } })
    });
    assert.equal(validated.status, 200);
    const validatedPayload = await validated.json() as { proposal: { id: string; changes: Array<{ field: string }>; patch: { maxAttempts: number } } };
    assert.equal(validatedPayload.proposal.patch.maxAttempts, 2);
    assert.equal(validatedPayload.proposal.changes[0]?.field, "maxAttempts");
    const stillUnchanged = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((response) => response.json()) as { config: { maxAttempts: number } };
    assert.equal(stillUnchanged.config.maxAttempts, beforeProposal.config.maxAttempts, "validation must not mutate config");
    const unconfirmed = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config/proposals/${validatedPayload.proposal.id}/apply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: false })
    });
    assert.equal(unconfirmed.status, 400);
    const applied = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config/proposals/${validatedPayload.proposal.id}/apply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true })
    });
    assert.equal(applied.status, 200);
    const appliedPayload = await applied.json() as { config: { maxAttempts: number } };
    assert.equal(appliedPayload.config.maxAttempts, 2);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
