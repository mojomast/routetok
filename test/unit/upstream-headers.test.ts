import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { buildUpstreamHeaders } from "../../src/proxy.js";

test("agentrouter upstream presents as opencode when the client user-agent is foreign", () => {
  const headers = buildUpstreamHeaders({ "user-agent": "curl/8.0" } as IncomingHttpHeaders, "openai", "stored-key", false, "agentrouter");
  assert.equal(headers["user-agent"], "opencode/1.15.13");
  assert.equal(headers.authorization, "Bearer stored-key");
});

test("agentrouter upstream keeps a genuine opencode client user-agent", () => {
  const headers = buildUpstreamHeaders({ "user-agent": "opencode/9.9.9" } as IncomingHttpHeaders, "openai", "stored-key", false, "agentrouter");
  assert.equal(headers["user-agent"], "opencode/9.9.9");
});

test("agentrouter upstream presents as opencode when the client sends no user-agent", () => {
  const headers = buildUpstreamHeaders({} as IncomingHttpHeaders, "anthropic", "stored-key", false, "agentrouter");
  assert.equal(headers["user-agent"], "opencode/1.15.13");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("other providers keep the routetok fallback and preserve a foreign user-agent", () => {
  const foreign = buildUpstreamHeaders({ "user-agent": "curl/8.0" } as IncomingHttpHeaders, "openai", "stored-key", false, "openrouter");
  assert.equal(foreign["user-agent"], "curl/8.0");
  const missing = buildUpstreamHeaders({} as IncomingHttpHeaders, "openai", "stored-key", false, "openrouter");
  assert.equal(missing["user-agent"], "routetok/0.1");
});

test("requesty anthropic requests still carry the key in x-api-key", () => {
  const headers = buildUpstreamHeaders({} as IncomingHttpHeaders, "anthropic", "stored-key", false, "requesty");
  assert.equal(headers["x-api-key"], "stored-key");
  assert.equal(headers.authorization, undefined);
});
