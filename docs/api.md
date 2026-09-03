# API

## Inference

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /messages` legacy Anthropic alias

Inference accepts `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key` when configured.

`GET /v1/models` returns virtual and custom routes plus physical text-generation routes whose provider is configured and whose spending policy allows use. Disabled routes, image-only routes, unconfigured providers, and paid or unknown-price external models that have not been explicitly enabled are omitted. Unknown capability metadata is not treated as an incompatibility.

Routed response metadata includes `x-request-id`, selected physical route aliases `x-router-model` and `x-router-route`, `x-router-provider`, and `x-router-attempts`. `x-router-terminal` states why routing ended: `complete`, `rate_limited`, `fallback_exhausted`, `non_retryable`, `request_timeout`, `client_cancelled`, `no_candidate`, `invalid_request`, or `stream_committed`.

`x-router-attempt-summary` is base64url-encoded UTF-8 JSON with this versioned compact shape:

```json
{"v":1,"a":[{"p":"openrouter","m":"openrouter:vendor/model","s":503,"o":"transient_error"}],"t":2}
```

In each attempt, `p`, `m`, `s`, and `o` mean provider, model, HTTP status (or `null` for a transport failure), and outcome. The optional `t` is the total attempt count when entries were omitted. The summary contains no prompt, response, credential, request body, or upstream error text. It is capped at 16 entries, provider/model/outcome strings are capped at 32/96/32 characters, and the encoded header is capped at 4,096 characters; if that limit is exceeded, the payload contains an empty `a` and total `t`. Decode with a base64url-aware decoder, cap decoded data before logging, parse as UTF-8 JSON, check `v`, and tolerate an omitted/truncated attempt list. `x-router-attempts` remains the total count.

A local `400` before selected-route headers (`x-router-model`, `x-router-route`, and `x-router-provider`) means RouteTok rejected malformed JSON, a non-object top level, an absent/blank/non-string `model`, or a non-boolean `stream`. Diagnostic terminal/count headers may still be present. RouteTok does not locally schema-validate tool definitions, JSON Schema keywords such as `oneOf` or `enum`, or `tool_choice`; those fields are preserved for the selected provider.

When `paidOpenRouterFallbackOrder` is non-empty, an explicit paid OpenRouter request uses it before the AgentRouter-only tail of the relevant protocol order. This is independent of `fallbackExplicitModels`, allowing other explicit routes to remain strict. The sequence is filtered for enablement, compatibility, and health and remains bounded by `maxAttempts`. This special chain does not apply to free OpenRouter, virtual, custom-cascade, or other explicit provider routes.

A `429` from a paid OpenRouter attempt advances immediately through this dedicated chain and records the provider cooldown. Other request classes retain RouteTok's terminal `429` behavior and do not fan out.

Fallback remains pre-output only. Retriable conditions include `429` while the paid OpenRouter cascade is active, transport failure, first-output timeout, and transient HTTP `502`, `503`, or `504`. The broader transient status set is `408`, `425`, `500`, `502`, `503`, `504`, and `529`; invalid, empty, or challenge responses and streams that fail, end, or exceed the metadata bound before semantic output may also advance. Retryable HTTP-200 error payloads and AgentRouter budget-pool exhaustion retain their existing special handling. Candidates and `maxAttempts` bound every chain.

A complete successful non-stream response never falls back. A stream commits as soon as semantic text, reasoning, refusal, or tool/function output appears and never falls back afterward, even if it later stalls, disconnects, or lacks a terminal event. Request body fields are preserved across attempts except for substitution of the selected physical `model`. Existing Anthropic thinking pin/strip behavior and AgentRouter DeepSeek historical-tool compatibility transformations may apply to Anthropic Messages; they do not alter OpenAI Chat Completions requests.

Fallback candidates are removed when catalog metadata explicitly conflicts with request requirements such as tools, image/audio input, or non-text output. Missing metadata remains unknown and does not by itself remove a candidate. A model-specific entitlement `403` blocks that route until health reset; unrelated account/policy `403` responses do not. In either case the bounded upstream error body is preserved for the client.

## Operations

- `GET /healthz`
- `GET /metrics`
- `GET /dashboard`
- `GET /sandbox`

Admin endpoints under `/admin/api/` require `DASHBOARD_TOKEN` when configured. They cover status, deterministic readiness, history, live requests, catalogs, credits, configuration, proposals, sandbox inference, retained request inspection, credentials, and circuit reset.

Managed proxy client keys require a configured `DASHBOARD_TOKEN`:

- `GET /admin/api/client-keys` lists key IDs, labels, creation times, and whether the environment key is configured.
- `POST /admin/api/client-keys` accepts `{ "label": "..." }`, creates a high-entropy client key, and returns its secret exactly once.
- `DELETE /admin/api/client-keys/:id` immediately revokes one managed key.

Only SHA-256 digests are persisted. Managed keys and the environment `PROXY_API_KEY` are both accepted by OpenAI and Anthropic-compatible inference endpoints.

`POST /admin/api/sandbox` accepts an optional `parameters.maxOutputMiB` integer from 1 to 64. The default remains 4 MiB. This changes only the bounded response bytes accepted by the authenticated sandbox runner; it is not forwarded to providers and does not change `max_tokens`.

Arena speech endpoints are also protected by dashboard authentication:

- `GET /admin/api/audio/capabilities` returns bounded OpenRouter speech plus local Speaches and Requesty transcription model inventories. Local models use the `local:` namespace and appear before `requesty:` models; only models confirmed by current discovery are advertised. The initial release advertises only catalog-confirmed free TTS models.
- `POST /admin/api/audio/speech` accepts strict JSON containing a namespaced free OpenRouter speech model, up to 4,096 input characters, an optional advertised voice, MP3 or PCM output, and optional speed. The explicit default is PCM when `responseFormat` is omitted. It returns bounded audio bytes and does not retry.
- `POST /admin/api/audio/transcriptions` accepts bounded multipart form data containing one audio file, one approved `local:` or `requesty:` model, and an optional two-letter language. It returns sanitized transcript text and usage. Local requests go only to the startup-configured Speaches API root; Requesty requests use the effective Requesty credential.

Audio content is never passed through the text proxy or added to request retention, metrics, history, or Fieldbook persistence. The two audio operations share a separate concurrency limit of two.

Fieldbook image endpoints are protected by dashboard authentication:

- `GET /admin/api/images/capabilities` returns `unconfigured` with no models when OpenRouter credentials are absent; otherwise it returns explicitly enabled OpenRouter image-output models and bounded generation options.
- `POST /admin/api/images/generations` accepts at most 1 MiB of valid JSON containing one enabled `openrouter:` model, a prompt, and optional aspect ratio, quality, and PNG/JPEG/WebP/SVG format values. Malformed JSON returns `400` and an oversized request returns `413`. It requests one image through OpenRouter's dedicated Image API, allows only one active generation, validates MIME, base64, decoded size, raster signatures, and passive SVG structure, and returns ephemeral data URLs plus sanitized reported usage.

Image bytes do not enter RouteTok metrics, request retention, Fieldbook IndexedDB, notes, forks, or exports.

`GET /admin/api/readiness` returns a bounded, deterministic projection of authentication posture, catalog freshness, configured-provider counts, viable models by protocol, free and paid/unknown enablement, health counts, stale route entries, and fixed-enum next actions. It excludes credentials, base URLs, paths, and raw upstream errors.

`POST /admin/api/assistant/plan` creates a bounded comparison plan from a natural-language request. It returns only validated `chat`/`design` mode, one to four eligible physical lanes, optional generation parameters, an improved prompt, rationale, warnings, provider destinations, and cost class. Model IDs may repeat when independent samples of the same model are requested. Planning never executes inference comparisons or configuration mutations.

Assistant diagnosis uses a two-stage lazy resource request. The first model pass selects from an allowlist of dashboard resources; the final pass receives only those bounded API results. Raw request bodies are never available to this workflow.

Credential mutation is write-only:

- `PUT /admin/api/providers/:provider/credentials/apiKey`
- `DELETE /admin/api/providers/:provider/credentials/apiKey`
- OpenRouter also supports `managementKey`.

No credential endpoint returns key material or key-derived fragments.
