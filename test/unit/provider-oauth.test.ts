import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderOAuthStore } from "../../src/provider-oauth.js";
import type { ProviderRuntime } from "../../src/types.js";

function codexIdToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function writeTokens(dataDir: string, providers: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dataDir, "secrets", "provider-oauth.json"), JSON.stringify({ version: 1, providers }), { mode: 0o600 });
}

test("OAuth tokens refresh before expiry, apply runtime state, and never leak through status", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentrouter-oauth-"));
  const providers: ProviderRuntime[] = [
    { id: "openai-codex", configured: false, apiKey: "", baseUrl: "https://chatgpt.com/backend-api/codex", endpoints: ["responses"] },
    { id: "github-copilot", configured: false, apiKey: "", baseUrl: "https://api.individual.githubcopilot.com", endpoints: ["chat", "responses"] }
  ];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/copilot_internal/v2/token")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-token");
      return new Response(JSON.stringify({ token: "copilot-token;proxy-ep=proxy.individual.githubcopilot.com;", expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "refresh_token");
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, id_token: codexIdToken("acct_refreshed") }), { status: 200 });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
  try {
    await writeTokens(dataDir, {
      "openai-codex": { access: "old-access", refresh: "old-refresh", expires: Date.now() + 1_000, accountId: "acct_old" },
      "github-copilot": { access: "expired-copilot", refresh: "github-token", expires: Date.now() + 1_000 }
    });
    const store = new ProviderOAuthStore(dataDir, providers, { onConnected: () => {} }, fetchImpl);
    await store.load();

    assert.equal(store.status("openai-codex")[0]?.connected, true);
    assert.doesNotMatch(JSON.stringify(store.status()), /access|refresh|old-access|github-token/);

    await store.prepare(providers[0]!);
    assert.equal(providers[0]!.apiKey, "new-access");
    assert.equal(providers[0]!.configured, true);
    assert.equal(providers[0]!.oauthHeaders?.["chatgpt-account-id"], "acct_refreshed");

    await store.prepare(providers[1]!);
    assert.equal(providers[1]!.apiKey, "copilot-token;proxy-ep=proxy.individual.githubcopilot.com;");
    assert.equal(providers[1]!.baseUrl, "https://api.individual.githubcopilot.com");
    assert.equal(providers[1]!.oauthHeaders?.["copilot-integration-id"], "vscode-chat");

    const directory = path.join(dataDir, "secrets");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "provider-oauth.json"))).mode & 0o777, 0o600);
    assert.match(await readFile(path.join(directory, "provider-oauth.json"), "utf8"), /new-refresh/);

    await store.disconnect("github-copilot");
    assert.equal(providers[1]!.configured, false);
    assert.equal(providers[1]!.apiKey, "");
    assert.equal(providers[1]!.oauthHeaders, undefined);
    assert.ok(calls.some((url) => url.endsWith("/copilot_internal/v2/token")), "copilot refresh must be attempted");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OAuth login rejects unsupported providers and browser mode for Copilot", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentrouter-oauth-"));
  const store = new ProviderOAuthStore(dataDir, [], { onConnected: () => {} }, (() => Promise.reject(new Error("network disabled"))) as typeof fetch);
  try {
    assert.equal(ProviderOAuthStore.isOAuthProvider("openai-codex"), true);
    assert.equal(ProviderOAuthStore.isOAuthProvider("openrouter"), false);
    await assert.rejects(() => store.startLogin("github-copilot", { method: "browser" }), /device authorization flow/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
