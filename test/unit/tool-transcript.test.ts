import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicWirePayload,
  anthropicWireTools,
  createAnthropicToolUseAccumulator,
  createOpenAiToolCallAccumulator,
  openAiWireMessages,
  openAiWireTools,
  parseSandboxTools,
  parseSandboxTranscript
} from "../../src/sandbox-tools.js";

const validTool = () => ({
  name: "time_now",
  description: "Return the current UTC time",
  input_schema: { type: "object", properties: { timezone: { type: "string" } } }
});

test("sandbox tool schema validation rejects out-of-bounds tool declarations", () => {
  const good = parseSandboxTools([validTool()]);
  assert.equal(good.length, 1);
  assert.equal(good[0]!.name, "time_now");
  assert.deepEqual(parseSandboxTools([]), []);
  assert.throws(() => parseSandboxTools("tools"), /array/);
  assert.throws(() => parseSandboxTools(null), /array/);
  assert.throws(() => parseSandboxTools(Array.from({ length: 17 }, () => validTool())), /no more than|1 to 16/);
  assert.throws(() => parseSandboxTools([{ ...validTool(), name: "TimeNow" }]), /match \^\[a-z0-9_\]/);
  assert.throws(() => parseSandboxTools([{ ...validTool(), name: "t!" }]), /match \^\[a-z0-9_\]/);
  assert.throws(() => parseSandboxTools([validTool(), validTool()]), /unique/);
  assert.throws(() => parseSandboxTools([{ ...validTool(), description: "x".repeat(2001) }]), /description/);
  assert.throws(() => parseSandboxTools([{ name: "bare", description: "d" }]), /input_schema/);
  assert.throws(() => parseSandboxTools([{ name: "bare", description: "d", input_schema: [] }]), /input_schema/);
  assert.throws(() => parseSandboxTools([{ name: "deep", description: "d", input_schema: nestedObject(9) }]), /bounded/);
  assert.throws(() => parseSandboxTools([{ name: "wide", description: "d", input_schema: { type: "object", properties: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, { type: "string" }])) } }]), /bounded/);
});

function nestedObject(depth: number): Record<string, unknown> {
  let value: unknown = { type: "string" };
  for (let index = 0; index < depth; index += 1) value = { type: "object", properties: { nested: value } };
  return value as Record<string, unknown>;
}

test("neutral transcript parses text and tool history with pairing rules", () => {
  const text = parseSandboxTranscript([{ role: "user", content: "What time is it?" }]);
  assert.equal(text.length, 1);
  const transcript = parseSandboxTranscript([
    { role: "user", content: "What time is it?" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "time_now", args: {} }] },
    { role: "tool", tool_call_id: "call_1", content: '{"now":"2026-09-04T00:00:00.000Z"}' }
  ]);
  assert.equal(transcript[1]!.role, "assistant");
  assert.equal((transcript[1] as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id, "call_1");
  assert.throws(() => parseSandboxTranscript([{ role: "user", content: "x" }, { role: "tool", tool_call_id: "missing", content: "x" }]), /unknown tool call/);
  assert.throws(() => parseSandboxTranscript([
    { role: "user", content: "x" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "time_now", args: {} }] },
    { role: "tool", tool_call_id: "call_1", content: "one" },
    { role: "tool", tool_call_id: "call_1", content: "two" }
  ]), /repeats/);
  assert.throws(() => parseSandboxTranscript([
    { role: "user", content: "x" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "time_now", args: {} }] },
    { role: "tool", tool_call_id: "call_1", name: "other", content: "one" }
  ]), /does not match/);
  assert.throws(() => parseSandboxTranscript([
    { role: "user", content: "x" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "time_now", args: {} }, { id: "call_1", name: "time_now", args: {} }] }
  ]), /unique/);
  assert.throws(() => parseSandboxTranscript([{ role: "user", content: "" }]), /non-empty/);
  assert.throws(() => parseSandboxTranscript([
    { role: "user", content: "x", tool_calls: [{ id: "c", name: "time_now", args: {} }] }
  ]), /Only assistant/);
});

test("transcript budget caps reject oversized histories", () => {
  const messages = Array.from({ length: 41 }, (_, index) => ({ role: "user" as const, content: `message ${index}` }));
  assert.throws(() => parseSandboxTranscript(messages), /1 and 40/);
  const huge = { role: "user" as const, content: "x".repeat(500_001) };
  assert.throws(() => parseSandboxTranscript([huge]), /100,000/);
  const across = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: "y".repeat(30_000) }));
  assert.throws(() => parseSandboxTranscript(across), /500,000/);
  const tooManyCalls = [
    { role: "user", content: "x" },
    { role: "assistant", content: "", tool_calls: Array.from({ length: 9 }, (_, index) => ({ id: `call_${index}`, name: "time_now", args: {} })) }
  ];
  assert.throws(() => parseSandboxTranscript(tooManyCalls), /1 to 8/);
});

test("neutral transcript translates to OpenAI and Anthropic wire protocols", () => {
  const turns = parseSandboxTranscript([
    { role: "user", content: "Look it up" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "catalog_lookup", args: { query: "flash" } }, { id: "call_2", name: "time_now", args: {} }] },
    { role: "tool", tool_call_id: "call_1", content: '{"matches":2}' },
    { role: "tool", tool_call_id: "call_2", content: '{"now":"2026-01-01"}' },
    { role: "assistant", content: "Two results at 2026-01-01." }
  ]);
  const openAi = openAiWireMessages(turns);
  assert.equal(openAi[0]!.role, "user");
  assert.deepEqual((openAi[1] as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls[0], {
    id: "call_1",
    type: "function",
    function: { name: "catalog_lookup", arguments: JSON.stringify({ query: "flash" }) }
  });
  assert.equal((openAi[3] as { role: string }).role, "tool");
  assert.deepEqual(openAiWireTools([validTool()])[0], { type: "function", function: { name: "time_now", description: "Return the current UTC time", parameters: validTool().input_schema } });

  const anthropic = anthropicWirePayload([...turns.slice(0, 1), ...turns.slice(1, 5)]);
  assert.equal(anthropic.messages[0]!.role, "user");
  const assistant = anthropic.messages[1] as { content: Array<Record<string, unknown>> };
  assert.equal(assistant.content[0]!.type, "tool_use");
  assert.equal(assistant.content[0]!.name, "catalog_lookup");
  const grouped = anthropic.messages[2] as { content: Array<{ type: string; tool_use_id: string }> };
  assert.equal(grouped.content.length, 2);
  assert.equal(grouped.content[0]!.type, "tool_result");
  assert.equal(grouped.content[0]!.tool_use_id, "call_1");
  assert.equal(grouped.content[1]!.tool_use_id, "call_2");
  const final = anthropic.messages[3] as { role: string; content: string };
  assert.equal(final.role, "assistant");
  assert.equal(final.content, "Two results at 2026-01-01.");
});

test("anthropic payload hoists system text and groups consecutive tool results", () => {
  const payload = anthropicWirePayload(parseSandboxTranscript([
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Go" },
    { role: "assistant", content: "thinking…", tool_calls: [{ id: "call_1", name: "scratchpad_read", args: {} }] },
    { role: "tool", tool_call_id: "call_1", content: "scratch contents" },
    { role: "user", content: "Now summarize" },
    { role: "assistant", content: "Summary." }
  ]));
  assert.equal(payload.system, "You are helpful.");
  assert.equal(payload.messages.length, 5);
  const toolUser = payload.messages[2] as { content: Array<Record<string, unknown>> };
  assert.equal(toolUser.content.length, 1);
  assert.equal((toolUser.content[0] as { content: string }).content, "scratch contents");
  const toolAssistant = payload.messages[1] as { content: Array<Record<string, unknown>> };
  assert.deepEqual(toolAssistant.content[0], { type: "text", text: "thinking…" });
});

test("stream tool-call accumulators normalize OpenAI and Anthropic deltas", () => {
  const openAi = createOpenAiToolCallAccumulator();
  openAi.consume({ tool_calls: [{ index: 0, id: "call_9", function: { name: "time_now" } }] });
  openAi.consume({ tool_calls: [{ index: 0, function: { arguments: '{"zone":' } }] });
  openAi.consume({ tool_calls: [{ index: 0, function: { arguments: '"utc"}' } }] });
  openAi.consume({ tool_calls: [{ index: 1, function: { arguments: "{}" } }] });
  openAi.consume({});
  const openAiCalls = openAi.finish();
  assert.equal(openAiCalls.length, 1);
  assert.deepEqual(openAiCalls[0], { id: "call_9", name: "time_now", args: { zone: "utc" } });

  const anthropic = createAnthropicToolUseAccumulator();
  anthropic.consume({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "catalog_lookup" } });
  anthropic.consume({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } });
  anthropic.consume({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"deepseek"}' } });
  anthropic.consume({ type: "content_block_stop", index: 0 });
  const anthropicCalls = anthropic.finish();
  assert.deepEqual(anthropicCalls[0], { id: "toolu_1", name: "catalog_lookup", args: { query: "deepseek" } });
});
