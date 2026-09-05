import assert from "node:assert/strict";
import test from "node:test";
import { streamEventBlocks, StreamInspector, StreamSanitizer } from "../../src/proxy.js";

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

test("sanitizer refuses an unterminated event past the pending-buffer cap", () => {
  const sanitizer = new StreamSanitizer("openai", "/v1/chat/completions", "routed-model");
  const chunk = Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x".repeat(64 * 1024) } }] })}`);
  const secondChunk = Buffer.from("x".repeat(64 * 1024));
  assert.doesNotThrow(() => sanitizer.push(chunk));
  let overflowed: Error | null = null;
  try {
    while (true) sanitizer.push(secondChunk);
  } catch (error) {
    overflowed = error as Error;
  }
  assert.ok(overflowed, "an unterminated event beyond ~4 MiB must throw");
  assert.match(overflowed?.message ?? "", /SSE event exceeded/);
  assert.ok(sanitizer.finish().length === 0, "the terminal flush must not emit the oversized tail");
});

test("inspector refuses an unterminated event past the pending-buffer cap", () => {
  const inspector = new StreamInspector("openai");
  const chunk = Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x".repeat(64 * 1024) } }] })}`);
  assert.doesNotThrow(() => inspector.push(chunk));
  let overflowed: Error | null = null;
  try {
    while (true) inspector.push(Buffer.from("x".repeat(64 * 1024)));
  } catch (error) {
    overflowed = error as Error;
  }
  assert.ok(overflowed, "an unterminated event beyond ~4 MiB must throw");
  assert.match(overflowed?.message ?? "", /SSE event exceeded/);
});

test("unknown Anthropic event types are dropped and logged once per type", (t) => {
  const warns: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => { warns.push(String(message)); });

  const wire = (type: string) => `event: ${type}\ndata: ${JSON.stringify({ type, x: 1 })}\n\n`;

  const first = new StreamSanitizer("anthropic", "/v1/messages", "m");
  assert.equal(first.push(Buffer.from(wire("message_research_start"))).length, 0);
  assert.equal(first.push(Buffer.from(wire("message_research_start"))).length, 0);

  const second = new StreamSanitizer("anthropic", "/v1/messages", "m");
  assert.equal(second.push(Buffer.from(wire("message_research_start"))).length, 0);

  assert.equal(warns.length, 1, "the first drop of a type warns exactly once across streams");
  assert.match(warns[0] ?? "", /message_research_start/);

  assert.equal(second.push(Buffer.from(wire("message_another_new_type"))).length, 0);
  assert.equal(warns.length, 2, "a different unknown type warns again");
  assert.match(warns[1] ?? "", /message_another_new_type/);
});

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunked(protocol: "openai" | "anthropic", path: string, model: string, wire: string, boundaries: Array<{ from: number; to: number }>): string {
  const bytes = Buffer.from(wire);
  const sanitizer = new StreamSanitizer(protocol, path, model);
  const out: Uint8Array[] = [];
  for (const boundary of boundaries) {
    out.push(...sanitizer.push(bytes.subarray(boundary.from, boundary.to)));
  }
  out.push(...sanitizer.finish());
  return Buffer.concat(out).toString("utf8");
}

function seededSplitPoints(byteLength: number, seed: number): Array<{ from: number; to: number }> {
  const random = mulberry32(seed);
  const points: number[] = [];
  for (let index = 1; index < byteLength; index++) {
    if (random() < 0.35) points.push(index);
  }
  points.push(byteLength);
  points.sort((a, b) => a - b);
  const boundaries: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (const point of points) {
    boundaries.push({ from, to: point });
    from = point;
  }
  return boundaries;
}

test("sanitizer output is byte-identical across every single split point", () => {
  const wire = [
    "event: response.created",
    `data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "r1", model: "vendor/m", object: "response" } })}`,
    "",
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, delta: "héllo wörld 你好 🚀" })}`,
    "",
    "event: billing_summary",
    `data: ${JSON.stringify({ type: "billing_summary", billing: { request: { tokens: { input: 1, output: 2 } } } })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "r1", model: "vendor/m", status: "completed" } })}`,
    "",
    ""
  ].join("\n");
  const expected = run("openai", "/v1/responses", "routed-model", wire);
  const byteLength = Buffer.byteLength(wire);
  for (let split = 1; split < byteLength; split++) {
    const actual = chunked("openai", "/v1/responses", "routed-model", wire, [{ from: 0, to: split }, { from: split, to: byteLength }]);
    assert.equal(actual, expected, `split at byte ${split} must not change the sanitized stream`);
  }
  assert.ok(!expected.includes("billing"), "billing frames must never leak into the sanitized stream");
});

test("sanitizer output is byte-identical under seeded multi-chunk splits and CRLF framing", () => {
  const wire = [
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "vendor/m", choices: [{ index: 0, delta: { content: "line one\n\rcontent 🎯" } }] })}`,
    "\r\n\r\n",
    "data: [DONE]",
    "\r\n\r\n"
  ].join("");
  const expected = run("openai", "/v1/chat/completions", "routed-model", wire);
  for (const seed of [1, 7, 42, 99, 2024]) {
    const actual = chunked("openai", "/v1/chat/completions", "routed-model", wire, seededSplitPoints(Buffer.byteLength(wire), seed));
    assert.equal(actual, expected, `seeded split ${seed} must not change the sanitized stream`);
  }
  assert.match(expected, /data: \[DONE\]/);
});

test("streamEventBlocks accepts CRLF, LF, and lone-CR separators", () => {
  const { blocks, remainder } = streamEventBlocks("a\n\nb\r\n\r\nc\r\rd");
  assert.deepEqual(blocks, ["a", "b", "c"]);
  assert.equal(remainder, "d");
  const single = streamEventBlocks("x");
  assert.deepEqual(single.blocks, []);
  assert.equal(single.remainder, "x");
});

test("lone-CR line endings survive an anthropic split sweep without duplication", () => {
  const wire = [
    "event: message_start\r",
    `data: ${JSON.stringify({ type: "message_start", message: { role: "assistant", model: "vendor/m" } })}\r`,
    "\r",
    "event: message_stop\r",
    `data: ${JSON.stringify({ type: "message_stop" })}\r`,
    "\r",
    ""
  ].join("");
  const expected = run("anthropic", "/v1/messages", "routed-model", wire);
  for (let split = 1; split < wire.length; split += 7) {
    const actual = chunked("anthropic", "/v1/messages", "routed-model", wire, [{ from: 0, to: split }, { from: split, to: wire.length }]);
    assert.equal(actual, expected, `lone-CR split at byte ${split} must not change the sanitized stream`);
  }
  assert.equal((expected.match(/event: message_start/g) ?? []).length, 1, "message_start must appear exactly once");
  assert.equal((expected.match(/event: message_stop/g) ?? []).length, 1, "message_stop must appear exactly once");
});
