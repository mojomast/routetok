# Troubleshooting

## No models

Check provider key status, catalog errors, and base URLs in the dashboard. Unknown-price external models must be explicitly enabled.

## Model appears but fails

Catalog visibility does not guarantee provider entitlement or current capacity. Inspect the request attempt chain, HTTP status, first-output deadline, and provider-specific error.

## Streams time out

Reasoning models may need `slowModelFirstEventTimeoutMs`. Heartbeats and metadata do not satisfy the semantic-output deadline.

## Generic endpoint unavailable

Confirm the base URL points to the API root and serves `GET /models` plus `POST /chat/completions`. Local HTTP endpoints require `GENERIC_OPENAI_ALLOW_PRIVATE=true`; no-auth endpoints require `GENERIC_OPENAI_AUTH=none`.

## Dashboard authentication

Clear the saved dashboard token from browser site storage and reconnect. Credential management requires `DASHBOARD_TOKEN` even on loopback.
