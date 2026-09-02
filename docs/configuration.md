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

Every provider has an `*_API_KEY` and optional `*_BASE_URL`; see `.env.example`. Dashboard-managed keys override environment values. Deleting a stored key creates a tombstone that suppresses environment fallback, except OpenCode which returns to `public`.

## Generic OpenAI

`GENERIC_OPENAI_BASE_URL` is startup-only trusted configuration. It should identify an API root, usually ending in `/v1`, not a request endpoint.

- HTTPS is required by default.
- Set `GENERIC_OPENAI_ALLOW_PRIVATE=true` to permit an exact private/local HTTP destination.
- `GENERIC_OPENAI_AUTH` is `bearer` or `none`.
- Responses support is disabled unless `GENERIC_OPENAI_SUPPORTS_RESPONSES=true`.
- Redirects are never followed.

## Routing Policy

Routing policy is edited through the dashboard and persisted in `config.json`. It includes protocol orders, free order, paid external enablement, disabled routes, timeout/circuit settings, fallback behavior, and custom cascades. Configuration writes use optimistic revisions.
