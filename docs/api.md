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

Admin endpoints under `/admin/api/` require `DASHBOARD_TOKEN` when configured. They cover status, deterministic readiness, history, live requests, catalogs, credits, configuration, proposals, sandbox inference, retained request inspection, credentials, and circuit reset.

Arena speech endpoints are also protected by dashboard authentication:

- `GET /admin/api/audio/capabilities` returns bounded OpenRouter speech plus local Speaches and Requesty transcription model inventories. Local models use the `local:` namespace and appear before `requesty:` models; only models confirmed by current discovery are advertised. The initial release advertises only catalog-confirmed free TTS models.
- `POST /admin/api/audio/speech` accepts strict JSON containing a namespaced free OpenRouter speech model, up to 4,096 input characters, an optional advertised voice, MP3 or PCM output, and optional speed. It returns bounded audio bytes and does not retry.
- `POST /admin/api/audio/transcriptions` accepts bounded multipart form data containing one audio file, one approved `local:` or `requesty:` model, and an optional two-letter language. It returns sanitized transcript text and usage. Local requests go only to the startup-configured Speaches API root; Requesty requests use the effective Requesty credential.

Audio content is never passed through the text proxy or added to request retention, metrics, history, or arena persistence. The two audio operations share a separate concurrency limit of two.

`GET /admin/api/readiness` returns a bounded, deterministic projection of authentication posture, catalog freshness, configured-provider counts, viable models by protocol, free and paid/unknown enablement, health counts, stale route entries, and fixed-enum next actions. It excludes credentials, base URLs, paths, and raw upstream errors.

`POST /admin/api/assistant/plan` creates a bounded comparison plan from a natural-language request. It returns only validated `chat`/`design` mode, one to four eligible physical lanes, optional generation parameters, an improved prompt, rationale, warnings, provider destinations, and cost class. Model IDs may repeat when independent samples of the same model are requested. Planning never executes inference comparisons or configuration mutations.

Assistant diagnosis uses a two-stage lazy resource request. The first model pass selects from an allowlist of dashboard resources; the final pass receives only those bounded API results. Raw request bodies are never available to this workflow.

Credential mutation is write-only:

- `PUT /admin/api/providers/:provider/credentials/apiKey`
- `DELETE /admin/api/providers/:provider/credentials/apiKey`
- OpenRouter also supports `managementKey`.

No credential endpoint returns key material or key-derived fragments.
