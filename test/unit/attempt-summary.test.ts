import assert from "node:assert/strict";
import test from "node:test";
import { decodeAttemptSummary, describeTerminal } from "../../src/attempt-summary.js";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("decodes the documented v1 payload", () => {
  const header = encode({ v: 1, a: [{ p: "openrouter", m: "openrouter:vendor/model", s: 503, o: "transient_error" }], t: 2 });
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.version, 1);
  assert.equal(result.ok && result.attempts.length, 1);
  assert.deepEqual(result.ok && result.attempts[0], {
    provider: "openrouter",
    model: "openrouter:vendor/model",
    status: 503,
    outcome: "transient_error"
  });
  assert.equal(result.ok && result.total, 2);
  assert.equal(result.ok && result.truncated, true);
});

test("decodes truncated payload with empty list and total", () => {
  const header = encode({ v: 1, a: [], t: 5 });
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.attempts, []);
  assert.equal(result.ok && result.total, 5);
  assert.equal(result.ok && result.truncated, true);
});

test("decodes payload without total as non-truncated", () => {
  const header = encode({ v: 1, a: [{ p: "agentrouter", m: "best-model", s: 200, o: "success" }] });
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.total, 1);
  assert.equal(result.ok && result.truncated, false);
});

test("tolerates omitted attempt list", () => {
  const header = encode({ v: 1 });
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.attempts, []);
  assert.equal(result.ok && result.total, 0);
  assert.equal(result.ok && result.truncated, false);
});

test("returns typed error for malformed base64", () => {
  const result = decodeAttemptSummary("!!!");
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && typeof result.error === "string");
});

test("returns typed error for malformed JSON", () => {
  const header = Buffer.from("not-json").toString("base64url");
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && typeof result.error === "string");
});

test("returns typed error for wrong version", () => {
  const header = encode({ v: 2, a: [], t: 0 });
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && typeof result.error === "string");
});

test("returns typed error for over-cap strings", () => {
  const overProvider = encode({ v: 1, a: [{ p: "x".repeat(33), m: "m", s: 503, o: "o" }] });
  assert.equal(decodeAttemptSummary(overProvider).ok, false);
  const overModel = encode({ v: 1, a: [{ p: "p", m: "m".repeat(97), s: 503, o: "o" }] });
  assert.equal(decodeAttemptSummary(overModel).ok, false);
  const overOutcome = encode({ v: 1, a: [{ p: "p", m: "m", s: 503, o: "o".repeat(33) }] });
  assert.equal(decodeAttemptSummary(overOutcome).ok, false);
});

test("returns typed error for too many entries", () => {
  const entries = Array.from({ length: 17 }, () => ({ p: "p", m: "m", s: 503, o: "o" }));
  const header = encode({ v: 1, a: entries });
  assert.equal(decodeAttemptSummary(header).ok, false);
});

test("decodes null status for transport failure", () => {
  const header = encode({ v: 1, a: [{ p: "openrouter", m: "openrouter:vendor/model", s: null, o: "transient_error" }] });
  const result = decodeAttemptSummary(header);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.attempts[0]?.status, null);
  assert.equal(result.ok && result.total, 1);
  assert.equal(result.ok && result.truncated, false);
});

test("never throws on empty and oversized input", () => {
  assert.equal(decodeAttemptSummary("").ok, false);
  assert.equal(decodeAttemptSummary("x".repeat(4097)).ok, false);
});

test("maps terminal values to short strings", () => {
  assert.equal(describeTerminal("complete"), "Completed");
  assert.equal(describeTerminal("rate_limited"), "Rate limited");
  assert.equal(describeTerminal("fallback_exhausted"), "Fallback exhausted");
  assert.equal(describeTerminal("non_retryable"), "Non-retryable error");
  assert.equal(describeTerminal("request_timeout"), "Request timed out");
  assert.equal(describeTerminal("client_cancelled"), "Client cancelled");
  assert.equal(describeTerminal("no_candidate"), "No candidate available");
  assert.equal(describeTerminal("invalid_request"), "Invalid request");
  assert.equal(describeTerminal("stream_committed"), "Stream committed");
  assert.equal(describeTerminal("other"), "Unknown");
});
