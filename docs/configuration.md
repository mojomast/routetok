# Configuration

Copy `.env.example` to `.env`. RouteTok uses Node's environment-file support and does not rewrite `.env`.

## Service

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `8787` | Listen port |
| `PROXY_API_KEY` | empty | Client inference authentication |
| `DASHBOARD_TOKEN` | empty | Dashboard/admin authentication |
| `DATA_DIR` | `./data` | Runtime state directory |

`PROXY_API_KEY` remains the baseline client credential and is useful for bootstrap and recovery. Once `DASHBOARD_TOKEN` is configured, API Setup can create additional labelled client keys without changing the environment or restarting RouteTok. Managed keys are additive and individually revocable.

## Docker Compose

Compose overrides `HOST`, `PORT`, and `DATA_DIR` inside the container with `0.0.0.0`, `8787`, and `/app/data`. Use these Compose-only variables to control host publishing:

| Variable | Default | Purpose |
|---|---|---|
| `ROUTETOK_DOCKER_BIND` | `127.0.0.1` | Host interface receiving the published container port |
| `ROUTETOK_DOCKER_PORT` | `8787` | Host port mapped to container port `8787` |

These variables do not alter native deployment settings. Containerized local-provider URLs must use `host.docker.internal` rather than `127.0.0.1`; see [Deployment](deployment.md#local-providers).

Every provider has an `*_API_KEY` and optional `*_BASE_URL`; see `.env.example`. Dashboard-managed keys override environment values. Deleting a stored key creates a tombstone that suppresses environment fallback, except OpenCode which returns to `public`.

## Local Transcription

RouteTok can expose a separately managed OpenAI-compatible Speaches service to the dashboard and Fieldbook:

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_STT_BASE_URL` | empty | Trusted local Speaches API root, normally `http://127.0.0.1:8000/v1` |
| `LOCAL_STT_MODEL` | `Systran/faster-whisper-small` | Advertised local transcription model |
| `LOCAL_STT_API_KEY` | empty | Optional bearer credential sent only to the configured local STT root |

RouteTok does not launch Speaches. A loopback-only, digest-pinned CPU example with persistent model cache is included at `deploy/local-stt/compose.yml`.

## Generic OpenAI

`GENERIC_OPENAI_BASE_URL` is startup-only trusted configuration. It should identify an API root, usually ending in `/v1`, not a request endpoint.

- HTTPS is required by default.
- Set `GENERIC_OPENAI_ALLOW_PRIVATE=true` to permit an exact private/local HTTP destination.
- `GENERIC_OPENAI_AUTH` is `bearer` or `none`.
- Responses support is disabled unless `GENERIC_OPENAI_SUPPORTS_RESPONSES=true`.
- Redirects are never followed.

## Routing Policy

Routing policy is edited through the dashboard and persisted in `config.json`. It includes protocol orders, free order, paid external enablement, disabled routes, timeout/circuit settings, fallback behavior, and custom cascades. Configuration writes use optimistic revisions.

Successful provider catalogs use the configured `catalogRefreshHours` freshness interval. Failed discovery attempts preserve the last usable models and become retryable after 30 seconds, so a transient startup or credential-refresh failure does not suppress discovery for the full normal interval.

`paidOpenRouterFallbackOrder` is a separate ordered list used only after an explicitly requested paid or unknown-price OpenRouter model becomes unavailable before output. A non-empty list activates this path independently of `fallbackExplicitModels`. Its configured, enabled paid OpenRouter alternatives are tried in exact order, followed by compatible AgentRouter entries from the protocol quality order as last resorts. Free OpenRouter, virtual, custom-cascade, and other explicit provider requests do not use this chain. Membership never enables a paid model, and the complete sequence remains bounded by `maxAttempts`.

For Qwen workloads, the current intended chain is requested Qwen -> Nex N2 Mini -> OpenRouter DeepSeek V4 Flash -> Solar Pro 4 -> AgentRouter. This is an operator policy, not a built-in mapping. Configure the exact current `openrouter:` catalog IDs, enable each paid/unknown-price alternative separately, and place desired AgentRouter last resorts in the applicable protocol order. `maxAttempts` counts the requested model and every fallback, so it can truncate this conceptual chain.

Explicit image-model enablement is also the spending boundary for direct Fieldbook image generation. Studio-requested images add a second per-request approval boundary in the browser.
