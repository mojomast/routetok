import assert from "node:assert/strict";
import test from "node:test";
import { RETAINED_REQUEST_TTL_MS, ProxyHandler, expiredRetained, requestContentRetentionEnabled } from "../../src/proxy.js";
import type { ProxyHandlerOptions } from "../../src/proxy.js";

function handler(): ProxyHandler {
  return new ProxyHandler({
    catalog: {} as unknown as ProxyHandlerOptions["catalog"],
    config: {} as unknown as ProxyHandlerOptions["config"],
    router: {} as unknown as ProxyHandlerOptions["router"],
    metrics: {} as unknown as ProxyHandlerOptions["metrics"]
  });
}

function internals(proxy: ProxyHandler): {
  retainedRequests: Map<string, { capturedAt: string; bytes: Buffer }>;
  retainedRequestBytes: number;
  retainRequestContent(requestId: string, bytes: Buffer): void;
} {
  return proxy as unknown as {
    retainedRequests: Map<string, { capturedAt: string; bytes: Buffer }>;
    retainedRequestBytes: number;
    retainRequestContent(requestId: string, bytes: Buffer): void;
  };
}

test("request content retention is on by default and off only for ROUTETOK_RETAIN_REQUEST_CONTENT=0", () => {
  assert.equal(requestContentRetentionEnabled({}), true);
  assert.equal(requestContentRetentionEnabled({ ROUTETOK_RETAIN_REQUEST_CONTENT: "1" }), true);
  assert.equal(requestContentRetentionEnabled({ ROUTETOK_RETAIN_REQUEST_CONTENT: "true" }), true);
  assert.equal(requestContentRetentionEnabled({ ROUTETOK_RETAIN_REQUEST_CONTENT: "0" }), false);
  assert.equal(requestContentRetentionEnabled({ ROUTETOK_RETAIN_REQUEST_CONTENT: " 0 " }), false);
  assert.equal(requestContentRetentionEnabled({ ROUTETOK_RETAIN_REQUEST_CONTENT: "" }), true);
});

test("expiredRetained applies the 24h window and treats unparseable dates as expired", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  assert.equal(expiredRetained(new Date(now - RETAINED_REQUEST_TTL_MS + 1).toISOString(), now), false);
  assert.equal(expiredRetained(new Date(now - RETAINED_REQUEST_TTL_MS).toISOString(), now), true);
  assert.equal(expiredRetained(new Date(now - 2 * RETAINED_REQUEST_TTL_MS).toISOString(), now), true);
  assert.equal(expiredRetained("not-a-date", now), true);
});

test("retention opt-out suppresses capture entirely", () => {
  const proxy = handler();
  const store = internals(proxy);
  const previous = process.env.ROUTETOK_RETAIN_REQUEST_CONTENT;
  try {
    process.env.ROUTETOK_RETAIN_REQUEST_CONTENT = "0";
    store.retainRequestContent("opt-out-id", Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "secret" }] })));
    assert.equal(store.retainedRequests.size, 0, "no content may be captured while retention is disabled");
    assert.equal(store.retainedRequestBytes, 0);
    assert.equal(proxy.getRetainedRequestContent("opt-out-id"), null);
  } finally {
    if (previous === undefined) delete process.env.ROUTETOK_RETAIN_REQUEST_CONTENT;
    else process.env.ROUTETOK_RETAIN_REQUEST_CONTENT = previous;
  }
});

test("retention capture stores bounded JSON and returns it while fresh", () => {
  const proxy = handler();
  const store = internals(proxy);
  const previous = process.env.ROUTETOK_RETAIN_REQUEST_CONTENT;
  try {
    delete process.env.ROUTETOK_RETAIN_REQUEST_CONTENT;
    store.retainRequestContent("captured-id", Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hello" }] })));
    assert.equal(store.retainedRequests.size, 1);
    const content = proxy.getRetainedRequestContent("captured-id");
    assert.equal(content?.sizeBytes, store.retainedRequestBytes);
    assert.equal(JSON.stringify(content?.body), JSON.stringify({ messages: [{ role: "user", content: "hello" }] }));
  } finally {
    if (previous === undefined) delete process.env.ROUTETOK_RETAIN_REQUEST_CONTENT;
    else process.env.ROUTETOK_RETAIN_REQUEST_CONTENT = previous;
  }
});

test("inserting new content evicts expired entries and keeps byte accounting correct", () => {
  const proxy = handler();
  const store = internals(proxy);
  const staleBytes = Buffer.from(JSON.stringify({ stale: true }));
  const freshBytes = Buffer.from(JSON.stringify({ fresh: true }));
  store.retainedRequests.set("stale-id", { capturedAt: new Date(Date.now() - 2 * RETAINED_REQUEST_TTL_MS).toISOString(), bytes: staleBytes });
  store.retainedRequestBytes = staleBytes.byteLength;
  store.retainRequestContent("fresh-id", freshBytes);
  assert.deepEqual([...store.retainedRequests.keys()], ["fresh-id"], "expired entries are dropped at insert time");
  assert.equal(store.retainedRequestBytes, freshBytes.byteLength);
});

test("reading an expired entry drops it and reports null", () => {
  const proxy = handler();
  const store = internals(proxy);
  const staleBytes = Buffer.from(JSON.stringify({ stale: true }));
  store.retainedRequests.set("expired-id", { capturedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), bytes: staleBytes });
  store.retainedRequestBytes = staleBytes.byteLength;
  assert.equal(proxy.getRetainedRequestContent("expired-id"), null);
  assert.equal(store.retainedRequests.has("expired-id"), false);
  assert.equal(store.retainedRequestBytes, 0);
});
