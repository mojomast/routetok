import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { ProviderRuntime } from "./types.js";

export const OAUTH_PROVIDER_IDS = ["openai-codex", "github-copilot"] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_BASE = "https://auth.openai.com";
const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex";
const CODEX_REDIRECT_PORT = 1455;
const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const COPILOT_OAUTH_BASE = "https://github.com";
const COPILOT_API_BASE = "https://api.github.com";
const COPILOT_INFERENCE_BASE = "https://api.individual.githubcopilot.com";
const COPILOT_HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
  "x-github-api-version": "2026-06-01"
};
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_ERROR_BODY = 512;

interface StoredOAuthTokens {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
}

interface PersistedOAuth { version: 1; providers: Partial<Record<OAuthProviderId, StoredOAuthTokens>> }

interface ActiveFlow {
  providerId: OAuthProviderId;
  state: "pending" | "connected" | "error" | "expired" | "idle";
  method: "browser" | "device";
  url: string;
  instructions: string;
  userCode: string | null;
  expiresAt: number;
  error: string | null;
  cancel: () => void;
}

export interface OAuthConnectionStatus {
  providerId: OAuthProviderId;
  connected: boolean;
  expiresAt: string | null;
  accountId: string | null;
  enterpriseUrl: string | null;
}

export interface OAuthFlowStatus {
  providerId: OAuthProviderId;
  state: "idle" | "pending" | "connected" | "error" | "expired";
  method: "browser" | "device" | null;
  url: string | null;
  instructions: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: string | null;
}

export interface OAuthLoginStart {
  providerId: OAuthProviderId;
  method: "browser" | "device";
  url: string;
  instructions: string;
  userCode: string | null;
  expiresAt: string;
}

export interface OAuthStartOptions {
  method?: "browser" | "device";
  enterpriseUrl?: string;
}

export interface ProviderOAuthHooks {
  onConnected: (providerId: OAuthProviderId) => Promise<void> | void;
}

const envText = (...names: string[]): string | null => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
};
const envPort = (name: string, fallback: number): number => {
  const value = Number(envText(name));
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : fallback;
};
const stripSlash = (value: string): string => value.replace(/\/+$/, "");

const codexAuthBase = (): string => stripSlash(envText("CODEX_OAUTH_BASE_URL") ?? CODEX_AUTH_BASE);
const codexApiBase = (): string => stripSlash(envText("CODEX_API_BASE_URL") ?? CODEX_API_BASE);
const codexClientId = (): string => envText("CODEX_OAUTH_CLIENT_ID") ?? CODEX_CLIENT_ID;
const codexRedirectPort = (): number => envPort("CODEX_OAUTH_REDIRECT_PORT", CODEX_REDIRECT_PORT);
const copilotOAuthBase = (): string => stripSlash(envText("COPILOT_OAUTH_BASE_URL") ?? COPILOT_OAUTH_BASE);
const copilotApiBase = (): string => stripSlash(envText("COPILOT_API_BASE_URL") ?? COPILOT_API_BASE);
const copilotClientId = (): string => envText("COPILOT_OAUTH_CLIENT_ID") ?? COPILOT_CLIENT_ID;
const copilotInferenceBase = (): string => stripSlash(envText("COPILOT_INFERENCE_BASE_URL") ?? COPILOT_INFERENCE_BASE);
const callbackHost = (): string => envText("ROUTETOK_OAUTH_CALLBACK_HOST") ?? "127.0.0.1";

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function codexAccountId(payload: Record<string, unknown>): string | null {
  for (const candidate of [payload.id_token, payload.access_token]) {
    if (typeof candidate !== "string") continue;
    const claims = decodeJwtClaims(candidate);
    if (!claims) continue;
    const auth = claims["https://api.openai.com/auth"];
    const nested = auth && typeof auth === "object" && !Array.isArray(auth)
      ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
    const firstOrganization = organizations[0] && typeof organizations[0] === "object" && !Array.isArray(organizations[0])
      ? (organizations[0] as Record<string, unknown>).id : undefined;
    const accountId = claims.chatgpt_account_id ?? nested ?? firstOrganization;
    if (typeof accountId === "string" && accountId) return accountId;
  }
  return null;
}

function copilotBaseFromToken(token: string): string | null {
  const match = /(?:^|;)\s*proxy-ep=([^;]+)/.exec(token);
  const host = match?.[1]?.trim().replace(/^proxy\./, "api.");
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !host.includes(".")) return null;
  return `https://${host}`;
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function respondHtml(response: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RouteTok authorization</title></head><body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem"><h1>RouteTok authorization</h1><p>${escapeHtml(message)}</p></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(body);
}

async function asObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json() as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth login timed out")), milliseconds);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const onAbort = () => { clearTimeout(timer); reject(new Error("Login cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ProviderOAuthStore {
  private state: PersistedOAuth = { version: 1, providers: {} };
  private readonly flows = new Map<OAuthProviderId, ActiveFlow>();
  private readonly refreshQueue = new Map<OAuthProviderId, Promise<void>>();
  private readonly directory: string;
  private readonly filePath: string;

  constructor(
    dataDir: string,
    private readonly providers: ProviderRuntime[],
    private readonly hooks: ProviderOAuthHooks,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.directory = path.join(dataDir, "secrets");
    this.filePath = path.join(this.directory, "provider-oauth.json");
  }

  static isOAuthProvider(id: string): id is OAuthProviderId {
    return (OAUTH_PROVIDER_IDS as readonly string[]).includes(id);
  }

  async load(): Promise<void> {
    try {
      this.state = this.validate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not load provider OAuth tokens: ${(error as Error).message}`);
    }
    for (const providerId of OAUTH_PROVIDER_IDS) this.apply(providerId);
  }

  status(providerId?: OAuthProviderId): OAuthConnectionStatus[] {
    const ids = providerId ? [providerId] : [...OAUTH_PROVIDER_IDS];
    return ids.map((id) => {
      const tokens = this.state.providers[id];
      return {
        providerId: id,
        connected: Boolean(tokens),
        expiresAt: tokens ? new Date(tokens.expires).toISOString() : null,
        accountId: tokens?.accountId ?? null,
        enterpriseUrl: tokens?.enterpriseUrl ?? null
      };
    });
  }

  flow(providerId: OAuthProviderId): OAuthFlowStatus {
    const active = this.flows.get(providerId);
    if (active) {
      return {
        providerId,
        state: active.state,
        method: active.method,
        url: active.url,
        instructions: active.instructions,
        userCode: active.userCode,
        expiresAt: new Date(active.expiresAt).toISOString(),
        error: active.error
      };
    }
    const tokens = this.state.providers[providerId];
    return {
      providerId,
      state: tokens ? "connected" : "idle",
      method: null,
      url: null,
      instructions: null,
      userCode: null,
      expiresAt: tokens ? new Date(tokens.expires).toISOString() : null,
      error: null
    };
  }

  cancelLogin(providerId: OAuthProviderId): OAuthFlowStatus {
    const active = this.flows.get(providerId);
    if (active) {
      active.state = "idle";
      active.cancel();
      this.flows.delete(providerId);
    }
    return this.flow(providerId);
  }

  async disconnect(providerId: OAuthProviderId): Promise<void> {
    this.cancelLogin(providerId);
    if (!Object.prototype.hasOwnProperty.call(this.state.providers, providerId)) return;
    const next = structuredClone(this.state);
    delete next.providers[providerId];
    await this.persist(next);
    this.state = next;
    this.apply(providerId);
  }

  async startLogin(providerId: OAuthProviderId, options: OAuthStartOptions = {}): Promise<OAuthLoginStart> {
    if (!ProviderOAuthStore.isOAuthProvider(providerId)) throw new Error("Unknown OAuth provider");
    this.cancelLogin(providerId);
    if (providerId === "openai-codex") {
      return options.method === "device" ? this.startCodexDevice() : this.startCodexBrowser();
    }
    if (options.method === "browser") throw new Error("GitHub Copilot uses the device authorization flow");
    return this.startCopilotDevice(options.enterpriseUrl);
  }

  async prepare(provider: ProviderRuntime): Promise<void> {
    if (!ProviderOAuthStore.isOAuthProvider(provider.id)) return;
    const providerId = provider.id;
    const tokens = this.state.providers[providerId];
    if (!tokens) return;
    if (tokens.expires - Date.now() <= TOKEN_REFRESH_MARGIN_MS) {
      const inFlight = this.refreshQueue.get(providerId);
      if (inFlight) {
        await inFlight;
      } else {
        const operation = this.refreshTokens(providerId);
        this.refreshQueue.set(providerId, operation);
        try {
          await operation;
        } finally {
          this.refreshQueue.delete(providerId);
        }
      }
    }
    this.apply(providerId);
  }

  private async refreshTokens(providerId: OAuthProviderId): Promise<void> {
    const tokens = this.state.providers[providerId];
    if (!tokens || tokens.expires - Date.now() > TOKEN_REFRESH_MARGIN_MS) return;
    const refreshed = providerId === "openai-codex"
      ? await this.refreshCodex(tokens)
      : await this.exchangeCopilotToken(tokens.refresh, tokens.enterpriseUrl);
    await this.persistTokens(providerId, refreshed);
  }

  private apply(providerId: OAuthProviderId): void {
    const provider = this.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    const tokens = this.state.providers[providerId];
    if (!tokens) {
      provider.apiKey = "";
      provider.configured = false;
      delete provider.oauthHeaders;
      if (providerId === "github-copilot") provider.baseUrl = copilotInferenceBase();
      return;
    }
    provider.apiKey = tokens.access;
    provider.configured = true;
    if (providerId === "openai-codex") {
      provider.baseUrl = codexApiBase();
      if (tokens.accountId) provider.oauthHeaders = { "chatgpt-account-id": tokens.accountId };
      else delete provider.oauthHeaders;
    } else {
      const enterprise = tokens.enterpriseUrl ? `https://copilot-api.${tokens.enterpriseUrl}` : null;
      provider.baseUrl = envText("COPILOT_INFERENCE_BASE_URL")
        ? copilotInferenceBase()
        : copilotBaseFromToken(tokens.access) ?? enterprise ?? copilotInferenceBase();
      provider.oauthHeaders = { ...COPILOT_HEADERS };
    }
  }

  private async startCodexBrowser(): Promise<OAuthLoginStart> {
    const pkce = createPkce();
    const state = randomBytes(16).toString("hex");
    const host = callbackHost();
    const port = codexRedirectPort();
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const authorize = new URL(`${codexAuthBase()}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", codexClientId());
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "openid profile email offline_access");
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("id_token_add_organizations", "true");
    authorize.searchParams.set("codex_cli_simplified_flow", "true");
    authorize.searchParams.set("originator", "routetok");

    let settle: (value: { code: string } | null) => void = () => {};
    const codePromise = new Promise<{ code: string } | null>((resolve) => { settle = resolve; });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        respondHtml(response, 404, "Callback route not found.");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        respondHtml(response, 400, "The sign-in state did not match. Start the connection again.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        respondHtml(response, 400, "The authorization code was missing.");
        return;
      }
      respondHtml(response, 200, "Authentication completed. You can close this window.");
      settle({ code });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); server.on("error", () => {}); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    } catch (error) {
      server.close();
      throw new Error(`Could not start the Codex OAuth callback listener on ${host}:${port} (${(error as Error).message}). Set CODEX_OAUTH_REDIRECT_PORT to a free port.`);
    }

    const expiresAt = Date.now() + FLOW_TIMEOUT_MS;
    const flow: ActiveFlow = {
      providerId: "openai-codex",
      state: "pending",
      method: "browser",
      url: authorize.toString(),
      instructions: "Complete sign-in in the browser window that opened.",
      userCode: null,
      expiresAt,
      error: null,
      cancel: () => { settle(null); server.close(); }
    };
    this.flows.set("openai-codex", flow);
    void this.runCodexBrowserFlow(server, codePromise, pkce.verifier, redirectUri);
    return this.publicStart(flow);
  }

  private async runCodexBrowserFlow(
    server: ReturnType<typeof createServer>,
    codePromise: Promise<{ code: string } | null>,
    verifier: string,
    redirectUri: string
  ): Promise<void> {
    try {
      const result = await withDeadline(codePromise, FLOW_TIMEOUT_MS);
      if (this.flows.get("openai-codex")?.state === "idle") return;
      if (!result) throw new Error("The sign-in request was cancelled.");
      const tokens = await this.exchangeCodexCode(result.code, verifier, redirectUri);
      await this.completeLogin("openai-codex", tokens);
    } catch (error) {
      this.failFlow("openai-codex", (error as Error).message);
    } finally {
      server.close();
    }
  }

  private async startCodexDevice(): Promise<OAuthLoginStart> {
    const response = await this.fetchImpl(`${codexAuthBase()}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: codexClientId() }),
      redirect: "error"
    }).catch((error: unknown) => {
      throw new Error(`OpenAI device authorization request failed: ${(error as Error).message}`);
    });
    if (!response.ok) throw new Error(`OpenAI device authorization failed with HTTP ${response.status}.`);
    const payload = await asObject(response);
    const deviceAuthId = typeof payload.device_auth_id === "string" ? payload.device_auth_id : "";
    const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
    const interval = Math.max(1, Number(payload.interval) || 5);
    if (!deviceAuthId || !userCode) throw new Error("The OpenAI device authorization response was invalid.");

    const expiresAt = Date.now() + FLOW_TIMEOUT_MS;
    const controller = new AbortController();
    const flow: ActiveFlow = {
      providerId: "openai-codex",
      state: "pending",
      method: "device",
      url: `${codexAuthBase()}/codex/device`,
      instructions: `Enter the code ${userCode} to finish connecting.`,
      userCode,
      expiresAt,
      error: null,
      cancel: () => controller.abort()
    };
    this.flows.set("openai-codex", flow);
    void this.runCodexDeviceFlow(deviceAuthId, userCode, interval, controller);
    return this.publicStart(flow);
  }

  private async runCodexDeviceFlow(deviceAuthId: string, userCode: string, interval: number, controller: AbortController): Promise<void> {
    try {
      const code = await this.pollCodexDevice(deviceAuthId, userCode, interval, controller.signal);
      const tokens = await this.exchangeCodexCode(code.authorizationCode, code.codeVerifier, `${codexAuthBase()}/deviceauth/callback`);
      await this.completeLogin("openai-codex", tokens);
    } catch (error) {
      if (controller.signal.aborted) {
        this.failFlow("openai-codex", "The sign-in request was cancelled.", "idle");
        return;
      }
      this.failFlow("openai-codex", (error as Error).message);
    }
  }

  private async pollCodexDevice(
    deviceAuthId: string,
    userCode: string,
    intervalSeconds: number,
    signal: AbortSignal
  ): Promise<{ authorizationCode: string; codeVerifier: string }> {
    const deadline = Date.now() + FLOW_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Login cancelled");
      const response = await this.fetchImpl(`${codexAuthBase()}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        redirect: "error",
        signal
      });
      if (response.ok) {
        const payload = await asObject(response);
        const authorizationCode = typeof payload.authorization_code === "string" ? payload.authorization_code : "";
        const codeVerifier = typeof payload.code_verifier === "string" ? payload.code_verifier : "";
        if (!authorizationCode || !codeVerifier) throw new Error("The OpenAI device token response was invalid.");
        return { authorizationCode, codeVerifier };
      }
      if (response.status !== 403 && response.status !== 404) {
        throw new Error(`OpenAI device authorization failed with HTTP ${response.status}.`);
      }
      await abortableSleep(intervalSeconds * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS, signal);
    }
    throw new Error("OpenAI device authorization timed out");
  }

  private async startCopilotDevice(enterpriseUrl?: string): Promise<OAuthLoginStart> {
    const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : null;
    if (enterpriseUrl && !domain) throw new Error("Invalid GitHub Enterprise URL or domain");
    const base = domain && domain !== "github.com" ? `https://${domain}` : copilotOAuthBase();
    const response = await this.fetchImpl(`${base}/login/device/code`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: copilotClientId(), scope: "read:user" }).toString(),
      redirect: "error"
    }).catch((error: unknown) => {
      throw new Error(`GitHub device authorization request failed: ${(error as Error).message}`);
    });
    if (!response.ok) throw new Error(`GitHub device authorization failed with HTTP ${response.status}.`);
    const payload = await asObject(response);
    const deviceCode = typeof payload.device_code === "string" ? payload.device_code : "";
    const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
    const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri : "";
    const interval = Math.max(1, Number(payload.interval) || 5);
    const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : FLOW_TIMEOUT_MS / 1000;
    if (!deviceCode || !userCode || !verificationUri) throw new Error("The GitHub device authorization response was invalid.");
    let parsedVerificationUri: URL;
    try {
      parsedVerificationUri = new URL(verificationUri);
    } catch {
      throw new Error("The GitHub device authorization response contained an untrusted verification URI.");
    }
    if (parsedVerificationUri.protocol !== "https:" && parsedVerificationUri.protocol !== "http:") {
      throw new Error("The GitHub device authorization response contained an untrusted verification URI.");
    }

    const expiresAt = Date.now() + expiresIn * 1000;
    const controller = new AbortController();
    const flow: ActiveFlow = {
      providerId: "github-copilot",
      state: "pending",
      method: "device",
      url: parsedVerificationUri.href,
      instructions: `Enter the code ${userCode} to finish connecting.`,
      userCode,
      expiresAt,
      error: null,
      cancel: () => controller.abort()
    };
    this.flows.set("github-copilot", flow);
    void this.runCopilotDeviceFlow(base, deviceCode, interval, expiresIn, enterpriseUrl, controller);
    return this.publicStart(flow);
  }

  private async runCopilotDeviceFlow(
    base: string,
    deviceCode: string,
    interval: number,
    expiresIn: number,
    enterpriseUrl: string | undefined,
    controller: AbortController
  ): Promise<void> {
    try {
      const githubToken = await this.pollGitHubDevice(base, deviceCode, interval, expiresIn, controller.signal);
      const tokens = await this.exchangeCopilotToken(githubToken, enterpriseUrl);
      await this.completeLogin("github-copilot", tokens);
    } catch (error) {
      if (controller.signal.aborted) {
        this.failFlow("github-copilot", "The sign-in request was cancelled.", "idle");
        return;
      }
      this.failFlow("github-copilot", (error as Error).message);
    }
  }

  private async pollGitHubDevice(
    base: string,
    deviceCode: string,
    intervalSeconds: number,
    expiresInSeconds: number,
    signal: AbortSignal
  ): Promise<string> {
    const deadline = Date.now() + expiresInSeconds * 1000;
    let interval = intervalSeconds;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Login cancelled");
      const response = await this.fetchImpl(`${base}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: copilotClientId(),
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }).toString(),
        redirect: "error",
        signal
      });
      const payload = await asObject(response);
      if (typeof payload.access_token === "string" && payload.access_token) return payload.access_token;
      const error = typeof payload.error === "string" ? payload.error : "";
      if (error === "authorization_pending") {
        await abortableSleep(interval * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS, signal);
        continue;
      }
      if (error === "slow_down") {
        interval += 5;
        await abortableSleep(interval * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS, signal);
        continue;
      }
      if (error) throw new Error(`GitHub device authorization failed: ${error}`);
      throw new Error("The GitHub device token response was invalid.");
    }
    throw new Error("GitHub device authorization timed out");
  }

  private async exchangeCodexCode(code: string, verifier: string, redirectUri: string): Promise<StoredOAuthTokens> {
    const payload = await this.postForm(`${codexAuthBase()}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: codexClientId(),
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    });
    return this.codexTokens(payload);
  }

  private async refreshCodex(tokens: StoredOAuthTokens): Promise<StoredOAuthTokens> {
    const payload = await this.postForm(`${codexAuthBase()}/oauth/token`, {
      grant_type: "refresh_token",
      client_id: codexClientId(),
      refresh_token: tokens.refresh
    });
    const next = this.codexTokens(payload);
    if (!next.accountId && tokens.accountId) next.accountId = tokens.accountId;
    return next;
  }

  private codexTokens(payload: Record<string, unknown>): StoredOAuthTokens {
    const access = typeof payload.access_token === "string" ? payload.access_token : "";
    const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
    const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3_600;
    if (!access || !refresh) throw new Error("The OpenAI token response was missing access or refresh tokens.");
    const accountId = codexAccountId(payload);
    return accountId
      ? { access, refresh, expires: Date.now() + expiresIn * 1000, accountId }
      : { access, refresh, expires: Date.now() + expiresIn * 1000 };
  }

  private async exchangeCopilotToken(githubToken: string, enterpriseUrl: string | undefined): Promise<StoredOAuthTokens> {
    const response = await this.fetchImpl(`${copilotApiBase()}/copilot_internal/v2/token`, {
      headers: { ...COPILOT_HEADERS, authorization: `Bearer ${githubToken}` },
      redirect: "error"
    });
    if (!response.ok) throw new Error(`GitHub Copilot token exchange failed with HTTP ${response.status}.`);
    const payload = await asObject(response);
    const access = typeof payload.token === "string" ? payload.token : "";
    const expiresAt = typeof payload.expires_at === "number" ? payload.expires_at : 0;
    if (!access || !expiresAt) throw new Error("The GitHub Copilot token response was invalid.");
    const normalizedEnterprise = enterpriseUrl ? normalizeDomain(enterpriseUrl) : null;
    return {
      access,
      refresh: githubToken,
      expires: expiresAt * 1000 - TOKEN_REFRESH_MARGIN_MS,
      ...(normalizedEnterprise && normalizedEnterprise !== "github.com" ? { enterpriseUrl: normalizedEnterprise } : {})
    };
  }

  private async postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "error"
    }).catch((error: unknown) => {
      throw new Error(`Token request failed: ${(error as Error).message}`);
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body ? `: ${body.slice(0, MAX_ERROR_BODY)}` : "";
      throw new Error(`Token request failed with HTTP ${response.status}${detail}`);
    }
    return asObject(response);
  }

  private async completeLogin(providerId: OAuthProviderId, tokens: StoredOAuthTokens): Promise<void> {
    await this.persistTokens(providerId, tokens);
    this.apply(providerId);
    const active = this.flows.get(providerId);
    if (active) {
      active.state = "connected";
      active.error = null;
    }
    try {
      await this.hooks.onConnected(providerId);
    } catch (error) {
      console.warn(`Provider ${providerId} connected but post-connect refresh failed:`, (error as Error).message);
    }
  }

  private failFlow(providerId: OAuthProviderId, message: string, state: "error" | "expired" | "idle" = "error"): void {
    const active = this.flows.get(providerId);
    if (!active || active.state === "idle") return;
    active.state = state;
    active.error = message;
  }

  private publicStart(flow: ActiveFlow): OAuthLoginStart {
    return {
      providerId: flow.providerId,
      method: flow.method,
      url: flow.url,
      instructions: flow.instructions,
      userCode: flow.userCode,
      expiresAt: new Date(flow.expiresAt).toISOString()
    };
  }

  private async persistTokens(providerId: OAuthProviderId, tokens: StoredOAuthTokens): Promise<void> {
    const next = structuredClone(this.state);
    next.providers[providerId] = tokens;
    await this.persist(next);
    this.state = next;
  }

  private validate(input: unknown): PersistedOAuth {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("oauth file must be an object");
    const value = input as Record<string, unknown>;
    if (value.version !== 1 || !value.providers || typeof value.providers !== "object" || Array.isArray(value.providers)) throw new Error("oauth file schema is invalid");
    const output: PersistedOAuth = { version: 1, providers: {} };
    for (const [providerId, entry] of Object.entries(value.providers as Record<string, unknown>)) {
      if (!ProviderOAuthStore.isOAuthProvider(providerId)) throw new Error("oauth file contains an unknown provider");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("oauth file contains an invalid entry");
      const record = entry as Record<string, unknown>;
      const access = record.access;
      const refresh = record.refresh;
      const expires = record.expires;
      if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh || typeof expires !== "number" || !Number.isFinite(expires)) {
        throw new Error("oauth file contains invalid tokens");
      }
      const tokens: StoredOAuthTokens = { access, refresh, expires };
      if (typeof record.accountId === "string" && record.accountId) tokens.accountId = record.accountId;
      if (typeof record.enterpriseUrl === "string" && record.enterpriseUrl) tokens.enterpriseUrl = record.enterpriseUrl;
      output.providers[providerId] = tokens;
    }
    return output;
  }

  private async persist(value: PersistedOAuth): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.provider-oauth.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
