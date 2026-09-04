import assert from "node:assert/strict";
import test from "node:test";
import { StreamSanitizer } from "../../src/proxy.js";

function run(protocol: "openai" | "anthropic", path: string, model: string, wire: string): string {
  const sanitizer = new StreamSanitizer(protocol, path, model);
  const pushed = sanitizer.push(Buffer.from(wire));
  const finished = sanitizer.finish();
  return Buffer.concat([...pushed, ...finished]).toString("utf8");
}

function parsedEvents(wire: string): Array<{ event: string; data: Record<string, unknown> }> {
  return wire.trim().split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const dataLine = lines.find((line) => line.startsWith("data: "));
    const eventLine = lines.find((line) => line.startsWith("event: "));
    if (!dataLine || dataLine.slice(6).trim() === "[DONE]") return { event: "", data: null };
    return {
      event: eventLine?.slice(7) ?? "",
      data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>
    };
  }).filter((entry) => entry.data !== null) as Array<{ event: string; data: Record<string, unknown> }>;
}

test("responses-wire events rewrite the nested response.model and skip the envelope key", () => {
  const createdEvents = parsedEvents(run("openai", "/v1/responses", "routed-model", [
    "event: response.created",
    `data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_x", model: "vendor/upstream", object: "response" } })}`,
    "",
    ""
  ].join("\n")));
  assert.equal(createdEvents[0]?.event, "response.created");
  const createdPayload = createdEvents[0]?.data;
  assert.equal((createdPayload?.response as Record<string, unknown>)?.model, "routed-model");
  assert.equal(createdPayload?.model, undefined, "the envelope must not gain a top-level model key");

  const completedEvents = parsedEvents(run("openai", "/v1/responses", "routed-model", [
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "resp_x", model: "vendor/upstream", status: "completed" } })}`,
    "",
    ""
  ].join("\n")));
  const completedPayload = completedEvents[0]?.data;
  assert.equal((completedPayload?.response as Record<string, unknown>)?.model, "routed-model");
  assert.equal((completedPayload?.response as Record<string, unknown>)?.status, "completed");
});

test("responses-wire events without a nested response object are left model-free", () => {
  const deltaEvents = parsedEvents(run("openai", "/v1/responses", "routed-model", [
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi", sequence_number: 2 })}`,
    "",
    ""
  ].join("\n")));
  assert.equal(deltaEvents[0]?.event, "response.output_text.delta");
  assert.equal(deltaEvents[0]?.data?.model, undefined);
});

test("chat-wire events keep the envelope model rewrite", () => {
  const chatEvents = parsedEvents(run("openai", "/v1/chat/completions", "routed-model", [
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "vendor/upstream", choices: [{ index: 0, delta: { content: "hi" } }] })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n")));
  assert.equal(chatEvents[0]?.data?.model, "routed-model");
  assert.match(run("openai", "/v1/chat/completions", "routed-model", [
    `data: ${JSON.stringify({ id: "x", choices: [] })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n")), /data: \[DONE\]/);
});

test("error frames on the responses wire are relayed and rewritten inside a nested response", () => {
  const failedEvents = parsedEvents(run("openai", "/v1/responses", "routed-model", [
    "event: response.failed",
    `data: ${JSON.stringify({ type: "response.failed", sequence_number: 3, response: { id: "resp_x", model: "vendor/upstream", status: "failed", error: { code: "x" } } })}`,
    "",
    ""
  ].join("\n")));
  assert.equal(failedEvents[0]?.event, "response.failed");
  assert.equal((failedEvents[0]?.data?.response as Record<string, unknown>)?.model, "routed-model");
});
