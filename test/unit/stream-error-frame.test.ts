import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { writeStreamError } from "../../src/proxy.js";

interface FakeResponse {
  chunks: Buffer[];
  destroyed: boolean;
  writableEnded: boolean;
}

function fakeResponse(destroyed = false): FakeResponse & ServerResponse {
  const state: FakeResponse = { chunks: [], destroyed, writableEnded: false };
  return {
    ...state,
    write(chunk: Uint8Array): boolean {
      state.chunks.push(Buffer.from(chunk));
      return true;
    }
  } as unknown as FakeResponse & ServerResponse;
}

function text(response: FakeResponse & ServerResponse): string {
  return Buffer.concat(response.chunks).toString("utf8");
}

test("openai writeStreamError emits the stream_interrupted frame followed by [DONE] when requested", async () => {
  const response = fakeResponse();
  await writeStreamError(response, "openai", "upstream_error", true);
  assert.equal(
    text(response),
    'data: {"error":{"message":"Upstream stream stalled or disconnected","type":"server_error","code":"stream_interrupted","reason":"upstream_error"}}\n\ndata: [DONE]\n\n'
  );
});

test("openai writeStreamError omits [DONE] unless requested", async () => {
  const response = fakeResponse();
  await writeStreamError(response, "openai", "reader_abort", false);
  assert.equal(
    text(response),
    'data: {"error":{"message":"Upstream stream stalled or disconnected","type":"server_error","code":"stream_interrupted","reason":"reader_abort"}}\n\n'
  );
});

test("anthropic writeStreamError emits the event: error frame without [DONE]", async () => {
  const response = fakeResponse();
  await writeStreamError(response, "anthropic", "idle_timeout", true);
  assert.equal(
    text(response),
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Upstream stream stalled or disconnected","reason":"idle_timeout"}}\n\n'
  );
});

test("writeStreamError stays silent on destroyed or ended responses", async () => {
  const destroyed = fakeResponse(true);
  await writeStreamError(destroyed, "openai", "deadline", true);
  assert.equal(text(destroyed), "");
  const ended = fakeResponse();
  ended.writableEnded = true;
  await writeStreamError(ended, "anthropic", "upstream_error", false);
  assert.equal(text(ended), "");
});
