# Provider OAuth

RouteTok can connect providers that authenticate with OAuth instead of a static API key. Connections are managed from the dashboard (`API KEYS` -> provider OAuth rows) and are available only when `DASHBOARD_TOKEN` is configured. Tokens are stored write-only under `DATA_DIR/secrets/provider-oauth.json` (directory `0700`, file `0600`) and are never returned to the browser.

Supported providers:

| Provider ID | Sign-in | Endpoints | Notes |
|---|---|---|---|
| `openai-codex` | ChatGPT browser PKCE, or device code | Responses (`/v1/responses`) only | Models are curated `openai-codex:<id>` IDs. Requests must stream. |
| `github-copilot` | GitHub device code | Chat and Responses | Models are discovered from the Copilot `/models` endpoint and namespaced `github-copilot:<id>`. |

xAI Grok is intentionally not implemented: xAI's public API documents API-key authentication only, with no OAuth flow.

## Connecting

1. Open **API KEYS** in the dashboard.
2. Use **CONNECT** (browser sign-in) or **DEVICE CODE** for OpenAI Codex, or **CONNECT** for GitHub Copilot, and complete the provider's prompt.
3. The dialog polls connection state and refreshes the catalog and status on success. **CANCEL** abandons a pending flow; **DISCONNECT** deletes the stored tokens.

New OAuth providers never enter automatic or free routing. Their models appear in `/v1/models` only after the connection succeeds and the model is explicitly enabled in routing policy (`enabledExternalModels`), exactly like other external providers.

## Refresh and request handling

- RouteTok refreshes an access token when it is within 60 seconds of expiry and persists the rotated tokens before the request.
- OpenAI Codex requests are rewritten to the Codex Responses endpoint and carry `ChatGPT-Account-Id` derived from the token's JWT claims. RouteTok forces `store: false` and `stream: true`, and supplies a default `instructions` when absent. Non-streaming Codex requests are rejected with `400` because the backend requires streaming.
- GitHub Copilot exchanges the long-lived GitHub token for a short-lived Copilot token, derives the API host from the token's `proxy-ep`, and sends the Copilot client headers (`Copilot-Integration-Id`, `Editor-Version`, `Editor-Plugin-Version`, `X-GitHub-Api-Version`, `User-Agent`).
- The dashboard's `POST /admin/api/providers/:id/oauth/start`, `GET .../oauth/status`, `POST .../oauth/cancel`, and `DELETE .../oauth` endpoints are authenticated by `DASHBOARD_TOKEN`; no token material is ever included in responses.

## Configuration overrides

The defaults work without configuration. Overrides are intended for headless deployments, proxies, and tests:

| Variable | Default | Purpose |
|---|---|---|
| `ROUTETOK_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Host for the Codex browser callback listener |
| `CODEX_OAUTH_REDIRECT_PORT` | `1455` | Codex browser callback port; must match the registered redirect URI |
| `CODEX_OAUTH_BASE_URL` | `https://auth.openai.com` | Codex authorization and token endpoints |
| `CODEX_API_BASE_URL` | `https://chatgpt.com/backend-api/codex` | Codex inference root |
| `CODEX_OAUTH_CLIENT_ID` | Codex CLI client ID | Override only for a registered OAuth app |
| `COPILOT_OAUTH_BASE_URL` | `https://github.com` | GitHub device authorization endpoints |
| `COPILOT_API_BASE_URL` | `https://api.github.com` | GitHub Copilot token exchange endpoint |
| `COPILOT_OAUTH_CLIENT_ID` | GitHub Copilot client ID | Override only for a registered OAuth app |
| `COPILOT_INFERENCE_BASE_URL` | `https://api.individual.githubcopilot.com` | Copilot inference root when the token does not carry a `proxy-ep` |

The Codex browser callback listener is bound to loopback only, validates the OAuth `state`, serves a fixed HTML page with no interpolated untrusted content, and closes as soon as the flow settles or times out (5 minutes).
