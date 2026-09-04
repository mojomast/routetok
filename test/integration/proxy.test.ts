import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { flattenAgentRouterDeepSeekToolHistory } from "../../src/proxy.js";
import { isolatedTestEnv, stopChild, waitFor } from "../support/process.js";

test("AgentRouter DeepSeek compatibility flattens only historical Anthropic tool blocks", () => {
  const input = {
    model: "deepseek-v4-flash",
    tools: [{ name: "bash", input_schema: { type: "object" } }],
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Checking" }, { type: "tool_use", id: "call_123", name: "bash", input: { command: "curl -X PATCH https://example.test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_123", content: "completed" }, { type: "text", text: "Continue" }] }
    ]
  };
  const output = flattenAgentRouterDeepSeekToolHistory(input);
  assert.deepEqual(output, {
    model: "deepseek-v4-flash",
    tools: input.tools,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Checking" }, { type: "text", text: "[Historical tool call: bash]" }] },
      { role: "user", content: [{ type: "text", text: "[Historical tool result]\ncompleted" }, { type: "text", text: "Continue" }] }
    ]
  });
  assert.deepEqual(input.messages[0]?.content[1], { type: "tool_use", id: "call_123", name: "bash", input: { command: "curl -X PATCH https://example.test" } });
});

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
  let releaseLiveStream: (() => void) | undefined;
  const liveStreamGate = new Promise<void>((resolve) => { releaseLiveStream = resolve; });
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
          },
          {
            model_name: "zz-entitlement-model",
            supported_endpoint_types: ["openai"],
            model_ratio: 1,
            completion_ratio: 1
          },
          {
            model_name: "zz-account-forbidden-model",
            supported_endpoint_types: ["openai"],
            model_ratio: 1,
            completion_ratio: 1
          }
        ]
      }));
      return;
    }
    if (request.url === "/opencode/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
      return;
    }
    if (request.url !== "/v1/chat/completions" && request.url !== "/v1/responses") {
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
    if (request.url === "/v1/responses") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp-test", object: "response", output: [], usage: { input_tokens: 11, output_tokens: 2, input_tokens_details: { cached_tokens: 7 } } }));
      return;
    }
    if (payload.model === "zz-entitlement-model") {
      response.writeHead(403, { "content-type": "application/json", "x-private": "hidden" });
      response.end(JSON.stringify({ error: { code: "model_access_denied", message: "Model is not accessible to this credential" }, preserved: "entitlement-body" }));
      return;
    }
    if (payload.model === "zz-account-forbidden-model") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "account_policy", message: "Account policy denied this request" }, preserved: "account-body" }));
      return;
    }
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
      const plan = JSON.stringify({ mode: "design", models: ["good-model", "good-model"], prompt: "Design two independent samples of a synthetic status card.", parameters: { maxTokens: 2048, temperature: 0.4 }, rationale: "Duplicate lanes measure output variance from the same model." }).replace(/}$/, ",}");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "planner", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: { content: plan }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "planner", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (payload.model === "good-model" && payload.stream === true && messages.some((message) => JSON.stringify(message).includes("selecting RouteTok dashboard API resources"))) {
      const request = JSON.stringify({ needs: ["capabilities", "readiness", "providers", "totals", "health"] }).replace(/}$/, ",}");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "needs", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: { content: request }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (payload.model === "good-model" && payload.stream === true && messages.some((message) => JSON.stringify(message).includes("sandbox output cap probe"))) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = `data: ${JSON.stringify({ id: "large", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: { content: "X".repeat(64 * 1024) }, finish_reason: null }] })}\n\n`;
      response.write(event);
      setTimeout(() => response.end(`${event.repeat(79)}data: ${JSON.stringify({ id: "large", object: "chat.completion.chunk", model: "good-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`), 20);
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
      const finish = () => response.end([
        'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","model":"good-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n"));
      if (messages.some((message) => JSON.stringify(message).includes("Reply OK"))) await liveStreamGate;
      else await new Promise((resolve) => setTimeout(resolve, 100));
      finish();
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
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(proxyPort),
      DATA_DIR: dataDir,
      AGENTROUTER_API_KEY: "test-upstream-key",
      AGENTROUTER_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      GROQ_API_KEY: "test-groq-key",
      GROQ_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}/opencode`,
      PROXY_API_KEY: "local-client-key"
    }),
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

    const readinessResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/readiness`);
    assert.equal(readinessResponse.status, 200);
    const readiness = await readinessResponse.json() as {
      authentication: { proxyEnabled: boolean; dashboardEnabled: boolean };
      catalog: { state: string; ageSeconds: number | null; errorPresent: boolean };
      providers: { configuredCount: number; configuredAndCatalogConnectedCount: number };
      viableEligibleModelCounts: { openai: number; anthropic: number };
      freeRouteCount: number;
      enabledPaidOrUnknownModelCount: number;
      health: { unhealthyModelCount: number; rateLimitedModelCount: number; blockedModelCount: number };
      staleConfiguredOrderEntries: { openai: number; anthropic: number; free: number; total: number };
      recommendedNextActions: string[];
    };
    assert.deepEqual(readiness.authentication, { proxyEnabled: true, dashboardEnabled: false });
    assert(readiness.providers.configuredCount >= readiness.providers.configuredAndCatalogConnectedCount);
    assert(readiness.viableEligibleModelCounts.openai >= 0 && readiness.viableEligibleModelCounts.anthropic >= 0);
    assert(readiness.catalog.ageSeconds === null || readiness.catalog.ageSeconds <= 31_536_000);
    assert(readiness.freeRouteCount >= 0 && readiness.enabledPaidOrUnknownModelCount >= 0);
    assert.equal(readiness.staleConfiguredOrderEntries.total, readiness.staleConfiguredOrderEntries.openai + readiness.staleConfiguredOrderEntries.anthropic + readiness.staleConfiguredOrderEntries.free);
    const readinessActions = new Set(["configure_provider", "refresh_catalog", "enable_eligible_models", "repair_stale_routes", "investigate_model_health", "review_credit_status", "ready"]);
    assert(readiness.recommendedNextActions.length > 0 && readiness.recommendedNextActions.every((action) => readinessActions.has(action)));
    assert.doesNotMatch(JSON.stringify(readiness), /baseUrl|credentials|lastError|test-groq-key|catalog returned HTTP 404/);

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
    const dashboardHtml = await dashboardPage.text();
    assert.match(dashboardHtml, /ROUTETOK<span>\/01<\/span>/);
    assert.match(dashboardHtml, /SUPPORT AGENT/);
    assert.match(dashboardHtml, /Connect Applications/);
    assert.match(dashboardHtml, /id="open-api-access"/);
    assert.match(dashboardHtml, /id="health-model-sort"/);
    assert.match(dashboardHtml, /id="health-model-options"/);
    assert.match(dashboardHtml, /id="paid-openrouter-order-list"/);
    assert.match(dashboardHtml, /id="reset-circuits"/);
    assert.doesNotMatch(dashboardHtml, /class="panel system-panel"/);
    assert.doesNotMatch(dashboardHtml, /data-sandbox-mode="(?:chat|design)"/);

    for (const sandboxPath of ["/sandbox", "/sandbox/"]) {
      const sandboxPage = await fetch(`http://127.0.0.1:${proxyPort}${sandboxPath}`);
      assert.equal(sandboxPage.status, 200);
      assert.equal(sandboxPage.headers.get("cache-control"), "no-store");
      assert.equal(sandboxPage.headers.get("x-frame-options"), "DENY");
      assert.equal(sandboxPage.headers.get("x-content-type-options"), "nosniff");
      assert.match(sandboxPage.headers.get("content-security-policy") ?? "", /default-src 'self'.*object-src 'none'.*frame-ancestors 'none'/);
      const sandboxHtml = await sandboxPage.text();
      assert.match(sandboxHtml, /Model Fieldbook/);
      assert.match(sandboxHtml, /\/sandbox\.js/);
      assert.match(sandboxHtml, /\/sandbox\.css/);
      assert.doesNotMatch(sandboxHtml, /(?:src|href)=["']\/(?:app\.js|styles\.css)/);
    }
    for (const asset of ["/sandbox.js", "/sandbox.css", "/fieldbook/panels.js", "/fieldbook/context-broker.js", "/fieldbook/studio-chat.js", "/fieldbook/image-approvals.js"]) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", asset.endsWith(".js") ? /text\/javascript/ : /text\/css/);
      assert.equal(response.headers.get("cache-control"), "public, max-age=300");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    }
    assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/fieldbook/not-mapped.js`)).status, 404, "Fieldbook paths are explicitly mapped, not directory-served");
    for (const galleryPath of ["/image-gallery", "/image-gallery/"]) {
      const galleryPage = await fetch(`http://127.0.0.1:${proxyPort}${galleryPath}`);
      assert.equal(galleryPage.status, 200);
      assert.equal(galleryPage.headers.get("cache-control"), "no-store");
      assert.match(galleryPage.headers.get("content-security-policy") ?? "", /script-src 'none'.*img-src 'self'/);
      const galleryHtml = await galleryPage.text();
      assert.match(galleryHtml, /RouteTok Logo Model Gallery/);
      assert.equal((galleryHtml.match(/class="logo-card"/g) ?? []).length, 19);
      assert.doesNotMatch(galleryHtml, /<script\b/i);
    }
    const galleryCss = await fetch(`http://127.0.0.1:${proxyPort}/image-gallery/gallery.css`);
    assert.equal(galleryCss.status, 200);
    assert.match(galleryCss.headers.get("content-type") ?? "", /text\/css/);

    const galleryManifest = await fetch(`http://127.0.0.1:${proxyPort}/image-gallery/manifest.json`);
    assert.equal(galleryManifest.status, 200);
    assert.equal(galleryManifest.headers.get("cache-control"), "no-store");
    assert.match(galleryManifest.headers.get("content-type") ?? "", /application\/json/);
    const gallery = await galleryManifest.json() as { requested: number; succeeded: number; reportedCostUsd: number; results: unknown[] };
    assert.equal(gallery.requested, 19);
    assert.equal(gallery.succeeded, 19);
    assert.equal(gallery.results.length, 19);
    assert(gallery.reportedCostUsd > 0);
    const gallerySvg = await fetch(`http://127.0.0.1:${proxyPort}/image-gallery/assets/recraft-recraft-v4-styles-vector.svg`);
    assert.equal(gallerySvg.status, 200);
    assert.equal(gallerySvg.headers.get("content-type"), "image/svg+xml");
    assert.equal(gallerySvg.headers.get("cache-control"), "public, max-age=86400, immutable");

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

    const responses = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local-client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "good-model", input: "cache accounting" })
    });
    assert.equal(responses.status, 200);
    const responsesRequestId = responses.headers.get("x-request-id");
    await responses.text();
    const responsesMetrics = await waitFor(async () => fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((result) => result.json()) as Promise<{
      metrics: { recent: Array<{ id: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }> };
    }>, (result) => result.metrics.recent.some((record) => record.id === responsesRequestId));
    const responsesRecord = responsesMetrics.metrics.recent.find((record) => record.id === responsesRequestId);
    assert.equal(responsesRecord?.usage.input, 11);
    assert.equal(responsesRecord?.usage.output, 2);
    assert.equal(responsesRecord?.usage.cacheRead, 7);
    assert.equal(responsesRecord?.usage.cacheWrite, 0);

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
    const cancellationMetrics = await waitFor(async () => fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((result) => result.json()) as Promise<{
      metrics: {
        totals: { clientCancellations: number; upstreamAttempts: number };
        recent: Array<{ status: number; attempts: Array<{ outcome: string }> }>;
      };
    }>, (result) => result.metrics.recent[0]?.status === 499);
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
    releaseLiveStream?.();
    const streamText = await streamResponse.text();
    assert.match(streamText, /FALLBACK-OK/);
    assert.doesNotMatch(streamText, /billing\.summary|data: null/);
    assert(Date.now() - streamStarted < 4_000, "heartbeat-only model should not extend its deadline");

    const streamRequestId = streamResponse.headers.get("x-request-id");
    const finalDashboard = await waitFor(async () => fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((result) => result.json()) as Promise<{
      metrics: {
        inFlight: unknown[];
        recent: Array<{
          id: string;
          ttftMs: number | null;
          generationDurationMs: number | null;
          outputTokensPerSecond: number | null;
          attempts: Array<{ firstOutputMs: number | null }>;
          usage: { costCny: number; estimatedCostUsd: number };
        }>;
      };
    }>, (result) => result.metrics.inFlight.length === 0 && result.metrics.recent[0]?.id === streamRequestId);
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
    const sandbox = await dashboardChat.json() as { results: Array<{ requestedModel: string; content: string; error: string | null; metrics: { route: string | null; endpoint: string; latencyMs: number } | null }> };
    assert.equal(sandbox.results.length, 2);
    assert.equal(sandbox.results.find((result) => result.requestedModel === "good-model")?.content, "FALLBACK-OK");
    assert.match(sandbox.results.find((result) => result.requestedModel === "bad-model")?.error ?? "", /HTTP 503|No healthy compatible/);
    assert.equal(sandbox.results.find((result) => result.requestedModel === "good-model")?.metrics?.route, "good-model");
    assert.equal(sandbox.results.find((result) => result.requestedModel === "good-model")?.metrics?.endpoint, "/v1/chat/completions");
    assert((sandbox.results.find((result) => result.requestedModel === "good-model")?.metrics?.latencyMs ?? -1) >= 0);
    const sandboxModelsCalled = calls.slice(sandboxCallsBefore).map((call) => call.model);
    assert.equal(sandboxModelsCalled.filter((model) => model === "good-model").length, 1);
    assert(sandboxModelsCalled.filter((model) => model === "bad-model").length <= 1, "sandbox must never fall back an explicit failed model");
    assert(calls.slice(sandboxCallsBefore).every((call) => call.userAgent === "opencode/1.15.13"), "internal AgentRouter sandbox calls must use the supported OpenCode identity");

    const providerDefault = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [{ id: "default", model: "good-model", parameters: { maxOutputMiB: 8 }, messages: [{ role: "user", content: "Use provider defaults" }] }] })
    });
    assert.equal(providerDefault.status, 200);
    const providerDefaultPayload = await providerDefault.json() as { results: Array<{ parameters: { maxOutputMiB?: number } }> };
    assert.equal(providerDefaultPayload.results[0]?.parameters.maxOutputMiB, 8);
    assert.equal(calls.at(-1)?.maxTokens, undefined, "provider-default mode must omit max_tokens upstream");
    const invalidOutputLimit = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "chat", requests: [{ id: "oversized-limit", model: "good-model", parameters: { maxOutputMiB: 65 }, messages: [{ role: "user", content: "Reject the limit" }] }] }) });
    assert.equal(invalidOutputLimit.status, 400);
    const defaultOutputLimit = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "chat", requests: [{ id: "default-output-limit", model: "good-model", messages: [{ role: "user", content: "sandbox output cap probe" }] }] }) });
    const defaultOutputPayload = await defaultOutputLimit.json() as { results: Array<{ error: string | null }> };
    assert.match(defaultOutputPayload.results[0]?.error ?? "", /exceeded 4 MiB/);
    const expandedOutputLimit = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "chat", requests: [{ id: "expanded-output-limit", model: "good-model", parameters: { maxOutputMiB: 6 }, messages: [{ role: "user", content: "sandbox output cap probe" }] }] }) });
    const expandedOutputPayload = await expandedOutputLimit.json() as { results: Array<{ content: string; error: string | null }> };
    assert.equal(expandedOutputPayload.results[0]?.error, null);
    assert.equal(expandedOutputPayload.results[0]?.content.length, 5 * 1024 * 1024);

    const duplicateLanes = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "chat", requests: [
        { id: "sample-1", model: "good-model", messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Produce an independent sample" }] },
        { id: "sample-2", model: "good-model", messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Produce an independent sample" }] }
      ] })
    });
    assert.equal(duplicateLanes.status, 200);
    const duplicatePayload = await duplicateLanes.json() as { results: Array<{ id: string; requestedModel: string }> };
    assert.deepEqual(duplicatePayload.results.map((result) => result.id), ["sample-1", "sample-2"]);
    assert(duplicatePayload.results.every((result) => result.requestedModel === "good-model"));
    assert(calls.slice(-2).every((call) => (call.messages[0] as { role?: string })?.role === "system"));

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
    const plannedPayload = await planned.json() as { plan: { mode: string; models: string[]; prompt: string; parameters: { maxTokens?: number; temperature?: number }; rationale: string; providerDestinations: Array<{ lane: number; model: string; provider: string }> } };
    assert.equal(plannedPayload.plan.mode, "design");
    assert.deepEqual(plannedPayload.plan.models, ["good-model", "good-model"]);
    assert.equal(plannedPayload.plan.parameters.maxTokens, 2048);
    assert.match(plannedPayload.plan.prompt, /status card/i);
    assert.deepEqual(plannedPayload.plan.providerDestinations.map((destination) => destination.lane), [1, 2]);

    const diagnosisCallsBefore = calls.length;
    const diagnosed = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/sandbox`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "diagnose", requests: [{ id: "diagnose", model: "good-model", parameters: { maxTokens: 512 }, messages: [{ role: "user", content: "Analyze token totals and model health" }] }] })
    });
    assert.equal(diagnosed.status, 200);
    await diagnosed.text();
    const diagnosisCalls = calls.slice(diagnosisCallsBefore);
    assert.equal(diagnosisCalls.length, 2);
    const plannerMessages = JSON.stringify(diagnosisCalls[0]?.messages);
    const diagnosisMessages = String((diagnosisCalls[1]?.messages[0] as { content?: unknown })?.content ?? "");
    assert.doesNotMatch(plannerMessages, /dashboard_api_response_json|explain_and_propose_only|viableEligibleModelCounts|"totals"\s*:/);
    assert.match(diagnosisMessages, /dashboard_api_response_json/);
    assert.match(diagnosisMessages, /requestedResources.*capabilities.*readiness.*providers.*totals.*health/);
    assert.match(diagnosisMessages, /explain_and_propose_only|OpenAI Responses/);
    assert.match(diagnosisMessages, /viableEligibleModelCounts/);
    assert.match(diagnosisMessages, /"providerId":"groq".*"errorPresent":true/);
    assert.doesNotMatch(diagnosisMessages, /"baseUrl"|"credentials"|"source":"environment"|catalog returned HTTP 404|test-groq-key/);
    assert.doesNotMatch(diagnosisMessages, /"history"\s*:/);

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

    const strictExplicit = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/config`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fallbackExplicitModels: false })
    });
    assert.equal(strictExplicit.status, 200);
    const entitlement = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer local-client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "zz-entitlement-model", messages: [{ role: "user", content: "entitlement classification" }] })
    });
    assert.equal(entitlement.status, 403);
    assert.deepEqual(await entitlement.json(), { error: { code: "model_access_denied", message: "Model is not accessible to this credential" }, preserved: "entitlement-body" });
    const accountForbidden = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer local-client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "zz-account-forbidden-model", messages: [{ role: "user", content: "account policy classification" }] })
    });
    assert.equal(accountForbidden.status, 403);
    assert.deepEqual(await accountForbidden.json(), { error: { code: "account_policy", message: "Account policy denied this request" }, preserved: "account-body" });
    const classifiedHealth = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/status`).then((result) => result.json()) as {
      metrics: { health: Array<{ model: string; entitlementBlocked: boolean }> };
    };
    assert.equal(classifiedHealth.metrics.health.find((entry) => entry.model === "zz-entitlement-model")?.entitlementBlocked, true);
    assert.equal(classifiedHealth.metrics.health.find((entry) => entry.model === "zz-account-forbidden-model")?.entitlementBlocked, false);

    const imageCapabilities = await fetch(`http://127.0.0.1:${proxyPort}/admin/api/images/capabilities`).then((result) => result.json()) as { status: string; models: unknown[] };
    assert.deepEqual({ status: imageCapabilities.status, models: imageCapabilities.models }, { status: "unconfigured", models: [] });
  } finally {
    releaseLiveStream?.();
    await stopChild(child);
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
