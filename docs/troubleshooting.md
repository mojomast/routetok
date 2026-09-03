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

## Managed client key does not work

Confirm the application uses the complete one-time `rtk_…` secret as either `Authorization: Bearer <key>` or `x-api-key: <key>`. API Setup lists labels and IDs, not secret values. If the secret was lost, revoke that entry and create a replacement. The environment `PROXY_API_KEY` remains a separate accepted credential.

## Fieldbook does not load

Confirm `/sandbox.js` and the explicitly mapped `/fieldbook/*.js` modules return `200`. RouteTok must run from the project working directory with the complete `public/` tree present. Unknown module paths intentionally return `404`.

## Fieldbook state looks stale

Fieldbook data belongs to the current origin and browser profile in `routetok-model-fieldbook` IndexedDB. A different hostname, port, or browser profile has separate notes. Clear that site's IndexedDB only when you intend to remove local notes, evaluations, rooms, and Studio projects.

## Studio patch is rejected

Inspect the visible failure state. Patches are rejected for stale base revisions, malformed diffs, unsafe paths, excessive output, or changes outside the selected agent's file scope. Retry the same agent against current state or skip it; failed turns are refunded.

## Image model is unavailable

Image generation requires an OpenRouter image-output model explicitly enabled in dashboard configuration. Studio image cards are additionally revision-bound and require per-request approval. Rejected or stale cards intentionally make no provider request.

## Local transcription is unavailable

Verify Speaches is listening at `LOCAL_STT_BASE_URL`, the configured model is installed, and RouteTok can reach the loopback endpoint. RouteTok does not start or download models for an external Speaches deployment unless you use the included `deploy/local-stt/compose.yml` stack.
