# API

## Inference

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /messages` legacy Anthropic alias

Inference accepts `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key` when configured.

Response metadata includes `x-request-id`, `x-router-model`, `x-router-route`, `x-router-provider`, and `x-router-attempts`.

## Operations

- `GET /healthz`
- `GET /metrics`
- `GET /dashboard`
- `GET /sandbox`

Admin endpoints under `/admin/api/` require `DASHBOARD_TOKEN` when configured. They cover status, history, live requests, catalogs, credits, configuration, proposals, sandbox inference, retained request inspection, credentials, and circuit reset.

Credential mutation is write-only:

- `PUT /admin/api/providers/:provider/credentials/apiKey`
- `DELETE /admin/api/providers/:provider/credentials/apiKey`
- OpenRouter also supports `managementKey`.

No credential endpoint returns key material or key-derived fragments.
