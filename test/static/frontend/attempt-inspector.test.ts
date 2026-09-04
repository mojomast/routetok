import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const inspectorPath = "public/attempt-inspector.js";

interface AttemptEntry {
  p: string;
  m: string;
  s: number | null;
  o: string;
}

interface DecodedSummary {
  version: number;
  attempts: AttemptEntry[];
  total: number;
  truncated: boolean;
}

interface ReplayRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface InspectorApi {
  decodeAttemptSummary(header: string): DecodedSummary;
  humanizeTerminal(value: string): string;
  buildReplayCurl(request: ReplayRequest): string;
  mount(root: unknown, options?: { fetchWithAuth?: unknown }): void;
}

function encodeSummary(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function loadInspector(): Promise<{ source: string; inspector: InspectorApi }> {
  const source = await readFile(inspectorPath, "utf8");
  const holder: Record<string, unknown> = {};
  const context = vm.createContext({
    window: holder,
    document: undefined,
    navigator: {},
    atob: globalThis.atob,
    TextDecoder,
    Buffer
  });
  vm.runInContext(source, context, { filename: "attempt-inspector.js" });
  const inspector = holder.AttemptInspector as InspectorApi | undefined;
  assert.ok(inspector && typeof inspector === "object", "window.AttemptInspector is exposed");
  assert.equal(typeof inspector.decodeAttemptSummary, "function");
  assert.equal(typeof inspector.humanizeTerminal, "function");
  assert.equal(typeof inspector.buildReplayCurl, "function");
  assert.equal(typeof inspector.mount, "function");
  return { source, inspector };
}

test("attempt inspector exposes the mount API and redaction markers", async () => {
  const { source } = await loadInspector();
  assert.match(source, /window\.AttemptInspector/);
  assert.match(source, /mount\(root,\s*options\)/);
  assert.match(source, /fetchWithAuth/);
  assert.match(source, /decodeAttemptSummary/);
  assert.match(source, /humanizeTerminal/);
  assert.match(source, /buildReplayCurl/);
  assert.match(source, /REDACTED/);
  assert.match(source, /role",\s*"alert"/);
  assert.match(source, /truncated: showing/);
  assert.match(source, /x-router-attempt-summary/);
  assert.match(source, /\/admin\/api\/live/);
  assert.match(source, /\/admin\/api\/history/);
});

test("decodes a valid attempt summary header", async () => {
  const { inspector } = await loadInspector();
  const header = encodeSummary({
    v: 1,
    a: [
      { p: "openrouter", m: "openrouter:vendor/model", s: 503, o: "transient_error" },
      { p: "openrouter", m: "openrouter:vendor/other", s: null, o: "transport_failure" }
    ]
  });
  const decoded = inspector.decodeAttemptSummary(header);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.attempts.length, 2);
  assert.equal(decoded.total, 2);
  assert.equal(decoded.truncated, false);
  assert.equal(decoded.attempts[0]?.p, "openrouter");
  assert.equal(decoded.attempts[0]?.m, "openrouter:vendor/model");
  assert.equal(decoded.attempts[0]?.s, 503);
  assert.equal(decoded.attempts[0]?.o, "transient_error");
  assert.equal(decoded.attempts[1]?.s, null);
  assert.match(inspector.humanizeTerminal("fallback_exhausted"), /Fallback exhausted/);
  assert.match(inspector.humanizeTerminal("complete"), /Complete/);
});

test("handles truncated summaries with an empty attempt list and total", async () => {
  const { inspector } = await loadInspector();
  const header = encodeSummary({ v: 1, a: [], t: 9 });
  const decoded = inspector.decodeAttemptSummary(header);
  assert.equal(decoded.attempts.length, 0);
  assert.equal(decoded.total, 9);
  assert.equal(decoded.truncated, true);
  const partial = encodeSummary({ v: 1, a: [{ p: "p", m: "m", s: 429, o: "o" }], t: 4 });
  const partialDecoded = inspector.decodeAttemptSummary(partial);
  assert.equal(partialDecoded.truncated, true);
  assert.equal(partialDecoded.total, 4);
});

test("surfaces an error state for malformed headers", async () => {
  const { source, inspector } = await loadInspector();
  assert.throws(() => inspector.decodeAttemptSummary("!!!not-base64!!!"), /Malformed/);
  assert.throws(() => inspector.decodeAttemptSummary("   "), /Empty/);
  assert.throws(() => inspector.decodeAttemptSummary(encodeSummary({ v: 2, a: [] })), /Unsupported/);
  assert.throws(() => inspector.decodeAttemptSummary(encodeSummary({ nope: true })), /Malformed|Unsupported/);
  assert.match(source, /Malformed attempt summary header/);
});

test("curl builder redacts Authorization and secret headers", async () => {
  const { inspector } = await loadInspector();
  const command = inspector.buildReplayCurl({
    method: "POST",
    url: "https://router.local/v1/chat/completions",
    headers: {
      Authorization: "Bearer sk-live-secret",
      "x-api-key": "key-secret",
      "x-dashboard-token": "dashboard-secret",
      "content-type": "application/json"
    }
  });
  assert.match(command, /^curl /);
  assert.match(command, /chat\/completions/);
  assert.match(command, /REDACTED/);
  assert.doesNotMatch(command, /sk-live-secret/);
  assert.doesNotMatch(command, /key-secret/);
  assert.doesNotMatch(command, /dashboard-secret/);
  assert.match(command, /content-type/);
});
