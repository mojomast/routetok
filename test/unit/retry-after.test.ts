import assert from "node:assert/strict";
import test from "node:test";
import { retryAfterMs } from "../../src/proxy.js";

test("retry-after seconds are parsed and clamped to the one-hour bound", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "1" })), 1_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "0" })), 1_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "-5" })), 1_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "3600" })), 3_600_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "7200" })), 3_600_000);
});

test("retry-after HTTP-date form is parsed and clamped", () => {
  const near = retryAfterMs(new Headers({ "retry-after": new Date(Date.now() + 5_000).toUTCString() }));
  assert(near >= 3_000 && near <= 5_000, `near-future date should round to ~5s, got ${near}`);
  const farFuture = new Date(Date.now() + 7_200_000).toUTCString();
  assert.equal(retryAfterMs(new Headers({ "retry-after": farFuture })), 3_600_000);
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(retryAfterMs(new Headers({ "retry-after": past })), 1_000);
});

test("retry-after falls back to the default when absent or unparsable", () => {
  assert.equal(retryAfterMs(new Headers()), 30_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" })), 30_000);
});
