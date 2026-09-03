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

Explicit image-model enablement is also the spending boundary for direct Fieldbook image generation. Studio-requested images add a second per-request approval boundary in the browser.
