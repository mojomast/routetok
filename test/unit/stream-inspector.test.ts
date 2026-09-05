import assert from "node:assert/strict";
import test from "node:test";
import { StreamInspector } from "../../src/proxy.js";

function inspect(protocol: "openai" | "anthropic", wire: string): StreamInspector {
  const inspector = new StreamInspector(protocol);
  inspector.push(Buffer.from(wire));
  inspector.finish();
  return inspector;
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const textStart = (index: number) => sse("content_block_start", {
  type: "content_block_start",
  index,
  content_block: { type: "text", text: "" }
});

const messageStop = sse("message_stop", { type: "message_stop" });

test("anthropic server-tool block starts count as meaningful pre-commit output", () => {
  const serverToolUse = inspect("anthropic", sse("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "server_tool_use", id: "toolu_server_1", name: "web_search", input: {} }
  }) + messageStop);
  assert.equal(serverToolUse.meaningful, true, "a server_tool_use start must commit the pre-commit window");

  const webResult = inspect("anthropic", sse("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "web_search_tool_result",
      id: "tsearch_1",
      content: [{ type: "text", text: "result body" }]
    }
  }) + messageStop);
  assert.equal(webResult.meaningful, true, "a web_search_tool_result start with content must commit");
});

test("anthropic empty text block starts stay pre-commit", () => {
  const inspector = inspect("anthropic", textStart(0) + messageStop);
  assert.equal(inspector.meaningful, false, "an empty text start must not commit the window");
});

test("anthropic citation and input_json deltas generalize to payload keys beyond type", () => {
  const citationsDelta = inspect("anthropic", sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "citations_delta", citation: { cited_text: "quote", document_index: 0 } }
  }) + messageStop);
  assert.equal(citationsDelta.meaningful, true, "a citations_delta payload must commit");

  const emptyInputJson = inspect("anthropic", sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: "" }
  }) + messageStop);
  assert.equal(emptyInputJson.meaningful, false, "an empty input_json_delta must stay pre-commit");

  const emptyTextDelta = inspect("anthropic", sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "" }
  }) + messageStop);
  assert.equal(emptyTextDelta.meaningful, false, "an empty text delta must stay pre-commit");
});

test("anthropic non-empty text deltas still commit and byte-capture", () => {
  const inspector = inspect("anthropic", sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" }
  }) + messageStop);
  assert.equal(inspector.meaningful, true);
  assert.equal(inspector.outputUtf8Bytes, 5);
});

test("responses-wire server tool calls commit on added items", () => {
  const webSearchCall = inspect("openai", sse("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: 1,
    item: { id: "fc_1", type: "web_search_tool_call", status: "in_progress", arguments: "" }
  }) + sse("response.completed", { type: "response.completed", response: { status: "completed" } }));
  assert.equal(webSearchCall.meaningful, true, "a web_search_tool_call item must commit");
});

test("responses-wire empty text items and empty deltas stay pre-commit", () => {
  const emptyTextItem = inspect("openai", sse("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: 1,
    item: { id: "msg_1", type: "output_text", content: [], role: "assistant", status: "in_progress" }
  }) + sse("response.completed", { type: "response.completed", response: { status: "completed" } }));
  assert.equal(emptyTextItem.meaningful, false, "an output_text item with no content must stay pre-commit");

  const emptyDelta = inspect("openai", sse("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_1",
    sequence_number: 2,
    delta: ""
  }) + sse("response.completed", { type: "response.completed", response: { status: "completed" } }));
  assert.equal(emptyDelta.meaningful, false, "an empty output delta with only ids must stay pre-commit");
});

test("responses-wire content_part deltas carry output payload keys", () => {
  const contentPartDelta = inspect("openai", sse("response.content_part.delta", {
    type: "response.content_part.delta",
    item_id: "msg_1",
    sequence_number: 2,
    part: { type: "output_text", text: "streamed" }
  }) + sse("response.completed", { type: "response.completed", response: { status: "completed" } }));
  assert.equal(contentPartDelta.meaningful, true, "a content_part.delta with text must commit");
});

test("chat-wire role-only deltas do not commit the pre-commit window", () => {
  const roleOnly = inspect("openai", [
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n"));
  assert.equal(roleOnly.meaningful, false, "a role-only chat delta must stay pre-commit");

  const withContent = inspect("openai", [
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" } }] })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n"));
  assert.equal(withContent.meaningful, true);
});
