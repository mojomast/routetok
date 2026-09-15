import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentRouterDeepSeekThinking,
  StreamSanitizer,
  translateAgentRouterDeepSeekStructuredOutput,
  unwrapAgentRouterDeepSeekStructuredOutput
} from "../../src/proxy.js";

const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false
};

function structuredBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Return the structured result" }],
    response_format: { type: "json_schema", json_schema: { name: "probe", strict: true, schema } },
    ...extra
  };
}

test("json_schema is translated into a single forced tool with thinking disabled", () => {
  const { body, toolName } = translateAgentRouterDeepSeekStructuredOutput(
    structuredBody(),
    "agentrouter",
    "openai",
    "/v1/chat/completions",
    "deepseek-v4-flash"
  );
  assert.ok(toolName);
  assert.equal(toolName, "routetok_json_schema");
  assert.equal(body.response_format, undefined);
  assert.equal(body.tool_choice === undefined, false);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: toolName } });
  assert.deepEqual(body.thinking, { type: "disabled" });
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  const fn = tools[0]?.function as Record<string, unknown>;
  assert.equal(fn.name, toolName);
  assert.deepEqual(fn.parameters, schema);
});

test("a colliding tool name is suffixed instead of duplicated", () => {
  const { toolName } = translateAgentRouterDeepSeekStructuredOutput(
    structuredBody({ tools: [{ type: "function", function: { name: "routetok_json_schema", parameters: { type: "object" } } }] }),
    "agentrouter",
    "openai",
    "/v1/chat/completions",
    "deepseek-v4-flash"
  );
  assert.equal(toolName, "routetok_json_schema_1");
});

test("structured-output translation is scoped away from other providers, models, and formats", () => {
  const cases: Array<[string, Record<string, unknown>, Parameters<typeof translateAgentRouterDeepSeekStructuredOutput>[1], Parameters<typeof translateAgentRouterDeepSeekStructuredOutput>[3], string]> = [
    ["other provider", structuredBody(), "openrouter", "/v1/chat/completions", "deepseek-v4-flash"],
    ["other model", structuredBody(), "agentrouter", "/v1/chat/completions", "glm-5.3"],
    ["other endpoint", structuredBody(), "agentrouter", "/v1/responses", "deepseek-v4-flash"],
    ["json_object", { model: "deepseek-v4-flash", messages: [], response_format: { type: "json_object" } }, "agentrouter", "/v1/chat/completions", "deepseek-v4-flash"],
    ["missing schema", { model: "deepseek-v4-flash", messages: [], response_format: { type: "json_schema", json_schema: { name: "x" } } }, "agentrouter", "/v1/chat/completions", "deepseek-v4-flash"]
  ];
  for (const [name, input, providerId, path, model] of cases) {
    const { body, toolName } = translateAgentRouterDeepSeekStructuredOutput(input, providerId, "openai", path, model);
    assert.equal(toolName, null, name);
    assert.deepEqual(body, input, name);
  }
});

test("boolean thinking-off signals normalize to the structured ThinkingOptions shape", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["thinking:false", { thinking: false }, { thinking: { type: "disabled" } }],
    ["enable_thinking:false", { enable_thinking: false }, { thinking: { type: "disabled" } }],
    ["chat_template_kwargs", { chat_template_kwargs: { enable_thinking: false, temperature: 0.2 } }, { chat_template_kwargs: { temperature: 0.2 }, thinking: { type: "disabled" } }]
  ];
  for (const [name, extra, expected] of cases) {
    const body = normalizeAgentRouterDeepSeekThinking(
      { model: "deepseek-v4-flash", messages: [], ...extra },
      "agentrouter",
      "openai",
      "/v1/chat/completions",
      "deepseek-v4-flash"
    );
    assert.equal(body.thinking === false, false, `${name}: boolean thinking must be gone`);
    assert.deepEqual(body, { model: "deepseek-v4-flash", messages: [], ...expected }, name);
  }
});

test("reasoning_effort:none is preserved as the canonical thinking-off switch", () => {
  const body = normalizeAgentRouterDeepSeekThinking(
    { model: "deepseek-v4-flash", messages: [], enable_thinking: false, reasoning_effort: "none" },
    "agentrouter",
    "openai",
    "/v1/chat/completions",
    "deepseek-v4-flash"
  );
  assert.deepEqual(body, { model: "deepseek-v4-flash", messages: [], reasoning_effort: "none" });
});

test("unrelated requests are untouched by thinking normalization", () => {
  const input = { model: "deepseek-v4-flash", messages: [], thinking: { type: "enabled" }, reasoning_effort: "high" };
  assert.deepEqual(
    normalizeAgentRouterDeepSeekThinking(input, "agentrouter", "openai", "/v1/chat/completions", "deepseek-v4-flash"),
    input
  );
  assert.deepEqual(
    normalizeAgentRouterDeepSeekThinking({ thinking: false }, "openrouter", "openai", "/v1/chat/completions", "deepseek-v4-flash"),
    { thinking: false }
  );
});

test("non-stream structured output is unwrapped into content", () => {
  const value = {
    choices: [{
      index: 0,
      message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "routetok_json_schema", arguments: "{\"ok\": true}" } }] },
      finish_reason: "tool_calls"
    }]
  };
  unwrapAgentRouterDeepSeekStructuredOutput(value, "routetok_json_schema");
  assert.equal(value.choices[0]?.message.content, "{\"ok\": true}");
  assert.equal(value.choices[0]?.message.tool_calls, undefined);
  assert.equal(value.choices[0]?.finish_reason, "stop");
});

test("a foreign tool call is left untouched", () => {
  const value = {
    choices: [{
      index: 0,
      message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      finish_reason: "tool_calls"
    }]
  };
  unwrapAgentRouterDeepSeekStructuredOutput(value, "routetok_json_schema");
  assert.equal(value.choices[0]?.message.tool_calls?.length, 1);
  assert.equal(value.choices[0]?.message.content, "");
  assert.equal(value.choices[0]?.finish_reason, "tool_calls");
});

test("streamed structured output becomes content deltas and a stop finish", () => {
  const wire = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "routetok_json_schema", arguments: "" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"ok\":" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }] }
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  const sanitizer = new StreamSanitizer("openai", "/v1/chat/completions", "routed", "routetok_json_schema");
  const out = Buffer.concat([...sanitizer.push(Buffer.from(wire)), ...sanitizer.finish()]).toString("utf8");
  assert.ok(!out.includes("tool_calls"), "synthetic tool deltas must not reach the client");
  const parsed = out.split("\n\n").filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
  const content = parsed
    .flatMap((value) => (value.choices as Array<Record<string, unknown>> | undefined) ?? [])
    .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
    .filter((entry): entry is string => typeof entry === "string")
    .join("");
  assert.equal(content, "{\"ok\":true}");
  const finish = parsed
    .flatMap((value) => (value.choices as Array<Record<string, unknown>> | undefined) ?? [])
    .map((choice) => choice.finish_reason)
    .find((entry) => entry !== null && entry !== undefined);
  assert.equal(finish, "stop");
});

test("a stream that omits the upstream finish frame gains a synthetic stop", () => {
  const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "routetok_json_schema", arguments: "" } }] }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"ok\":true}" } }] }, finish_reason: null }] })}\n\n` +
    "data: [DONE]\n\n";
  const sanitizer = new StreamSanitizer("openai", "/v1/chat/completions", "routed", "routetok_json_schema");
  const out = Buffer.concat([...sanitizer.push(Buffer.from(wire)), ...sanitizer.finish()]).toString("utf8");
  const blocks = out.split("\n\n").filter(Boolean);
  assert.match(blocks.at(-2) ?? "", /"finish_reason":"stop"/);
  assert.equal(blocks.at(-1), "data: [DONE]");
});

test("a stream without the synthetic tool name is left untouched", () => {
  const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
  const sanitizer = new StreamSanitizer("openai", "/v1/chat/completions", "routed", "routetok_json_schema");
  const out = Buffer.concat([...sanitizer.push(Buffer.from(wire)), ...sanitizer.finish()]).toString("utf8");
  assert.match(out, /"content":"hi"/);
  assert.ok(!out.includes("routetok_json_schema"));
});
