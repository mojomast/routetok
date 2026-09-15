# API

## Inference

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /messages` legacy Anthropic alias

Inference accepts `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key` when configured.

When no proxy credential is configured, RouteTok allows unauthenticated loopback access as a single-user fallback, but browser-origin checks still apply on `GET /v1/models` and every `/v1` inference POST: a request carrying an `Origin` header that is not the loopback service's own origin (same host family and port) is rejected with `403` before any credential or routing logic runs. Pages served from other origins therefore cannot read the model list or drive inference on the fallback surface; requests without an `Origin` header (CLIs, server-to-server) are unaffected. Once `PROXY_API_KEY` or a managed client key is configured, the `Origin` header is ignored and credential checks govern.

`GET /v1/models` returns virtual and custom routes plus physical text-generation routes whose provider is configured and whose spending policy allows use. Disabled routes, image-only routes, unconfigured providers, and paid or unknown-price external models that have not been explicitly enabled are omitted. Unknown capability metadata is not treated as an incompatibility.

### Model Metadata

`GET /v1/models` remains the strict-compatible model-list representation. Its fields and filtering are unchanged, and no RouteTok-specific fields are added unless the client opts in with `GET /v1/models?include=routetok`. An unsupported or combined `include` mode returns `400` rather than being silently ignored.

With `include=routetok`, every model entry also has a nested `routetok` object using metadata schema version `1`. The versioned projection covers:

- canonical route identity, provider identity, and the provider's upstream model ID;
- route kind, including physical, built-in virtual, and custom cascade routes;
- catalog provenance and dedicated pricing provenance where known;
- supported wire protocols and concrete endpoints;
- context-window and maximum-output token limits;
- input and output modalities;
- tri-state capabilities, whose values are `true`, `false`, or `null` (unknown);
- the known supported request parameters;
- pricing currency, unit, source, rates, and provider-defined tiers;
- provider quality and completion ratios when available;
- free classification and current access/enablement state;
- configured routing ranks and ordered cascade members; and
- a safe, bounded health projection separated by protocol.

The schema distinguishes missing knowledge from empty or zero values. `null` means unknown or unavailable, while `[]` means the collection is known to be empty. Numeric zero and decimal-string rate `"0"` are actual zero values; clients must not derive either from `null`. Clients should inspect the schema version, tolerate additive fields, and use the canonical top-level model `id` when making requests.

When known, token prices are decimal strings denominated in USD per one million tokens. `currency`, `unit`, and `source` can be `null` when the upstream catalog does not establish them, and rates remain `null` rather than being estimated. Provider pricing-tier thresholds are token counts, not currency amounts. A free classification is explicit metadata and must not be inferred solely from a missing or zero-looking rate.

Virtual and custom-cascade entries are conservative aggregates. Candidate-independent facts may be reported, but context limits, output limits, modalities, capabilities, parameters, prices, and health that depend on which physical candidate is selected remain `null`. Ordered cascade members and routing ranks describe current routing configuration, not a guarantee that a candidate will be attempted; protocol compatibility, access policy, health, and attempt limits still apply.

Health metadata is operational and deliberately safe: it is protocol-specific, bounded, and excludes credentials, raw upstream errors, and sensitive request data. It is a point-in-time routing signal rather than a provider uptime guarantee.

Routed response metadata includes `x-request-id`, selected physical route aliases `x-router-model` and `x-router-route`, `x-router-provider`, and `x-router-attempts`. `x-router-terminal` states why routing ended: `complete`, `rate_limited`, `fallback_exhausted`, `non_retryable`, `request_timeout`, `client_cancelled`, `no_candidate`, `invalid_request`, or `stream_committed`.

`x-router-attempt-summary` is base64url-encoded UTF-8 JSON with this versioned compact shape:

```json
{"v":1,"a":[{"p":"openrouter","m":"openrouter:vendor/model","s":503,"o":"transient_error"}],"t":2}
```

In each attempt, `p`, `m`, `s`, and `o` mean provider, model, HTTP status (or `null` for a transport failure), and outcome. The optional `t` is the total attempt count when entries were omitted. The summary contains no prompt, response, credential, request body, or upstream error text. It is capped at 16 entries, provider/model/outcome strings are capped at 32/96/32 characters, and the encoded header is capped at 4,096 characters; if that limit is exceeded, the payload contains an empty `a` and total `t`. Decode with a base64url-aware decoder, cap decoded data before logging, parse as UTF-8 JSON, check `v`, and tolerate an omitted/truncated attempt list. `x-router-attempts` remains the total count.

A local `400` before selected-route headers (`x-router-model`, `x-router-route`, and `x-router-provider`) means RouteTok rejected malformed JSON, a non-object top level, an absent/blank/non-string `model`, or a non-boolean `stream`. Diagnostic terminal/count headers may still be present. RouteTok does not locally schema-validate tool definitions, JSON Schema keywords such as `oneOf` or `enum`, or `tool_choice`; those fields are preserved for the selected provider.

When `paidOpenRouterFallbackOrder` is non-empty, an explicit paid OpenRouter request uses it before the AgentRouter-only tail of the relevant protocol order. This is independent of `fallbackExplicitModels`, allowing other explicit routes to remain strict. The sequence is filtered for enablement, compatibility, and health and remains bounded by `maxAttempts`. This special chain does not apply to free OpenRouter, virtual, custom-cascade, or other explicit provider routes.

A `429` from a paid OpenRouter attempt advances immediately through this dedicated chain and records the provider cooldown. Virtual routes (`auto`/`best`/`free` and named custom cascades) also advance past a `429` while a candidate on a different provider remains in the chain, so one provider's rate limit does not starve a virtual request; when only same-provider candidates remain the response is a terminal `429` carrying the upstream `retry-after`. Explicit routes retain RouteTok's terminal `429` behavior and do not fan out. Providers inside their recorded cooldown window stay out of candidate chains entirely. When an exhausted chain ends in transient failures instead of a final `429`, the terminal `fallback_exhausted` response still carries the most recent upstream `retry-after` seen on the chain, so clients can back off even though the last observed error carried none.

Fallback remains pre-output only. Retriable conditions include `429` while the paid OpenRouter cascade is active, transport failure, first-output timeout, and transient HTTP `502`, `503`, or `504`. The broader transient status set is `408`, `425`, `500`, `502`, `503`, `504`, and `529`; invalid, empty, or challenge responses and streams that fail, end, or exceed the metadata bound before semantic output may also advance. Retryable HTTP-200 error payloads and AgentRouter budget-pool exhaustion retain their existing special handling. Candidates and `maxAttempts` bound every chain.

A complete successful non-stream response never falls back. A stream commits as soon as semantic text, reasoning, refusal, or tool/function output appears and never falls back afterward, even if it later stalls, disconnects, or lacks a terminal event. Request body fields are preserved across attempts except for substitution of the selected physical `model` and the scoped compatibility adjustments below. Anthropic thinking pin/strip behavior and AgentRouter DeepSeek historical-tool compatibility transformations apply only to Anthropic Messages; the OpenAI Chat Completions DeepSeek adjustments below are scoped to that provider, protocol, endpoint, and model family.

For AgentRouter OpenAI Chat Completions targeting the `deepseek-v4-*` family, RouteTok translates `response_format: { "type": "json_schema", "json_schema": { "schema": … } }` — which the upstream adapter rejects with `400 This response_format type is unavailable now` — into a single appended function tool carrying the caller's schema with `tool_choice: "auto"`, leaving the caller's thinking setting intact. The returned tool call is unwrapped back into `message.content` (and, for streams, `delta.content`) with `finish_reason: "stop"`, so clients keep the native content-JSON contract. Because the adapter rejects a forced `tool_choice` while thinking mode is active, an auto attempt that returns no matching tool call and no usable JSON content — including a `finish_reason: "length"` answer whose budget was consumed by reasoning — is retried once with a forced tool and `thinking: { "type": "disabled" }`. Boolean `thinking: false`, `enable_thinking: false`, and `chat_template_kwargs.enable_thinking: false` are normalized to the accepted `thinking: { "type": "disabled" }` shape, while a supplied `reasoning_effort: "none"` is preserved as the canonical thinking-off switch. All adjustments are per attempt and scoped to this provider/protocol/endpoint/model family; other models, providers, endpoints, and formats are unchanged. Thinking-on `json_schema` calls need enough output budget for the model's reasoning before it calls the schema tool.

A committed stream no longer ends silently on failure. Upstream error frames arriving after commit are relayed, including flat Responses `type:"error"` events. When a committed stream ends with an upstream-reported error (`response.failed`, a flat error frame, or an error-carrying event) or with no terminal event at all, RouteTok appends a protocol-shaped error frame before ending the response; OpenAI-Chat streams also receive a final `data: [DONE]`. The synthesized frame keeps the `stream_interrupted` envelope with a coarse `reason` sub-field (`idle_timeout`, `deadline`, `reader_abort`, or `upstream_error`) and a generic message; internals are never placed in the message text. Clients therefore observe a terminal error instead of a cleanly truncated stream.

The overall `requestTimeoutMs` deadline applies until a stream commits and for the full duration of non-stream requests. After a stream commits, only the client connection and the per-read `streamIdleTimeoutMs` idle bound govern the response: a committed stream may continue past the overall deadline while it keeps producing data, and a committed stream that goes idle ends with the reason-accurate `idle_timeout` frame. Pre-commit first-output and overall-deadline behavior is unchanged.



Fallback candidates are removed when catalog metadata explicitly conflicts with request requirements such as tools, image/audio input, or non-text output. Missing metadata remains unknown and does not by itself remove a candidate. A model-specific entitlement `403` blocks that route until health reset; unrelated account/policy `403` responses do not. In either case the bounded upstream error body is preserved for the client.

An opened circuit keeps a model out of candidate chains until `circuitOpenMs` elapses. An expired circuit transitions to half-open and admits at most one in-flight probe at a time (no concurrent probes). A failed, rate-limited, or entitlement-blocked probe re-opens the circuit immediately, and opening resets the inherited failure streak so the single probe outcome governs the next circuit state; a successful probe closes the circuit and resets model health.

## Operations

- `GET /healthz`
- `GET /metrics`
- `GET /dashboard`
- `GET /sandbox`

`GET /healthz` is the only unauthenticated endpoint. It returns minimal liveness (`{"status":"ok"}`) and never echoes catalog state, provider detail, or upstream error strings; the detailed operational projection lives on the authenticated `GET /admin/api/status` and `GET /admin/api/readiness`.

`GET /metrics` serves Prometheus text exposition and requires the same dashboard authentication as admin endpoints when `DASHBOARD_TOKEN` is configured (with the loopback origin fallback when no dashboard auth is configured). When no dashboard credential is configured the loopback fallback also rejects foreign browser `Origin` headers with `403` (same-origin loopback requests and header-less requests pass), matching the inference and admin origin gates. It exposes dual-prefixed families: the historical names are `agentrouter_router_*` and the canonical future names are `routetok_*` with identical semantics — both variants are emitted so old dashboards keep working while new ones use `routetok_`. Families cover request totals (`requests_total`, `request_failures_total`, `fallbacks_total`, `client_cancellations_total`, `upstream_attempts_total`), token and spend (`tokens_total` with `direction="input|output|cache_read|cache_write"`, `estimated_cost_usd_total`, `reported_cost_usd_total`, `cost_usd_total`, `cost_cny_total`), latency and throughput (`ttft_seconds_sum` with `ttft_samples_total`, `generation_seconds_sum` with `generation_output_tokens_total`), per-model routing health (`model_attempts_total`, `model_successes_total`, `model_failures_total`, `model_cancellations_total`, `model_latency_ewma_seconds`), the live gauge `inflight_requests`, and the per-model `circuit_state` gauge. Every family carries paired `# HELP` and `# TYPE` lines and label values are escaped per Prometheus rules. A future release will drop the `agentrouter_router_` prefix and keep only `routetok_`.

Admin endpoints under `/admin/api/` require `DASHBOARD_TOKEN` when configured. They cover status, deterministic readiness, history, live requests, catalogs, credits, configuration, proposals, sandbox inference, retained request inspection, credentials, and circuit reset.

Model-bearing admin responses expose corresponding normalized metadata fields, but their scopes and compatibility shapes differ from `/v1/models`:

- `GET /admin/api/status` is the raw operational control-plane view. It can describe normalized catalog and routing state, including routes that are not advertised to proxy clients, together with safe health and configuration context; optional unknown catalog collections can be omitted. Its `catalog` object carries discovery metadata plus `revision` (a monotonic catalog revision) and `modelCount`, but not the full model list — the dashboard polls this endpoint frequently without re-downloading the catalog.
- `GET /admin/api/catalog` returns the full catalog (`models` plus discovery metadata) under an `etag` derived from the same monotonic `revision`; a matching `If-None-Match` request answers `304` without a body. Clients should fetch it only when the `revision` they last stored differs from the one in `/admin/api/status`.
- `GET /admin/api/sandbox/catalog` is the Fieldbook selection view. It contains only models eligible for the authenticated sandbox's text workflows and includes sandbox-specific presentation or eligibility fields; unknown collections are returned as `null`.
- `GET /admin/api/images/capabilities` is the image-generation view. It contains only currently eligible image-output models and generation options, not the text proxy catalog; unknown collections are returned as `null`.

These authenticated endpoints must not be treated as interchangeable catalogs. They expose corresponding normalized metadata fields rather than the compatibility endpoint's nested schema object. Their metadata has the same null, empty-list, zero, pricing-unit, and conservative-aggregation semantics described above, while each endpoint applies its own access and modality filters.

Managed proxy client keys require a configured `DASHBOARD_TOKEN`:

- `GET /admin/api/client-keys` lists key IDs, labels, creation times, and whether the environment key is configured.
- `POST /admin/api/client-keys` accepts `{ "label": "..." }`, creates a high-entropy client key, and returns its secret exactly once.
- `DELETE /admin/api/client-keys/:id` immediately revokes one managed key.

Only SHA-256 digests are persisted. Managed keys and the environment `PROXY_API_KEY` are both accepted by OpenAI and Anthropic-compatible inference endpoints.

`POST /admin/api/sandbox` accepts an optional `parameters.maxOutputMiB` integer from 1 to 64. Output is unlimited by default; the cap bounds only the response bytes accepted by the authenticated sandbox runner and is not forwarded to providers, so `max_tokens` is unchanged. The sandbox reader accepts up to 4 MiB of JSON per request so multi-branch max-size transcripts (up to four branches of 40 messages and 500,000 characters each) reach the per-transcript validators; other admin JSON endpoints keep the 1 MiB reader bound. Malformed or oversized sandbox JSON returns `400`.

The sandbox lanes share one concurrency budget of eight in-flight model calls with the dashboard's proposal-generation and assistant-planning lanes: a request whose branches would push the budget past eight returns `429` with `retry-after: 1` before any model runs. The two audio operations keep their separate concurrency limit of two and likewise answer `429` with `retry-after: 1` while both slots are busy.

Arena speech endpoints are also protected by dashboard authentication:

- `GET /admin/api/audio/capabilities` returns bounded OpenRouter speech plus local Speaches and Requesty transcription model inventories. Local models use the `local:` namespace and appear before `requesty:` models; only models confirmed by current discovery are advertised. The initial release advertises only catalog-confirmed free TTS models, reports `unavailable` when a configured speech catalog contains no eligible free model, preserves provider-native pricing without inventing a currency/unit, and includes known context, modality, parameter, provenance, voice, and capability metadata. Its legacy `free` field remains Boolean; `freeStatus` is the tri-state source of truth and is `null` when cost cannot be established.
- `POST /admin/api/audio/speech` accepts strict JSON containing a namespaced free OpenRouter speech model, up to 4,096 input characters, an optional advertised voice, MP3 or PCM output, and optional speed. The explicit default is PCM when `responseFormat` is omitted. It returns bounded audio bytes and does not retry.
- `POST /admin/api/audio/transcriptions` accepts bounded multipart form data containing one audio file, one approved `local:` or `requesty:` model, and an optional two-letter language. It returns sanitized transcript text and usage. Local requests go only to the startup-configured Speaches API root; Requesty requests use the effective Requesty credential.

Audio content is never passed through the text proxy or added to request retention, metrics, history, or Fieldbook persistence. The two audio operations share a separate concurrency limit of two. Upstream redirects are never followed: discovery metadata GETs treat redirects as errors, and the POST operations surface a redirected response as a `502` instead of retrying elsewhere.

Fieldbook image endpoints are protected by dashboard authentication:

- `GET /admin/api/images/capabilities` returns `unconfigured` with no models when OpenRouter credentials are absent; otherwise it returns explicitly enabled OpenRouter image-output models and bounded generation options.
- `POST /admin/api/images/generations` accepts at most 1 MiB of valid JSON containing one enabled `openrouter:` model, a prompt, and optional aspect ratio, quality, and PNG/JPEG/WebP/SVG format values. Malformed JSON returns `400` and an oversized request returns `413`. It requests one image through OpenRouter's dedicated Image API, allows only one active generation (the single-flight gate is acquired atomically at start and released when the request finishes or fails), validates MIME, base64, decoded size, raster signatures, and passive SVG structure, and returns ephemeral data URLs plus sanitized reported usage. Upstream redirects are not followed: a redirected response is treated as a `502`.

Image bytes do not enter RouteTok metrics, request retention, Fieldbook IndexedDB, notes, forks, or exports.

`GET /admin/api/readiness` returns a bounded, deterministic projection of authentication posture, catalog freshness, configured-provider counts, viable models by protocol, free and paid/unknown enablement, health counts, stale route entries, and fixed-enum next actions. It excludes credentials, base URLs, paths, and raw upstream errors.

- `GET /admin/api/attempts/decode?header=...` decodes an `x-router-attempt-summary` value without provider calls. Missing `header` returns `400`, and values over 8KB return `400`.
- `GET /admin/api/route/simulate?model=...&protocol=openai&tools=true&inputModalities=text&outputModalities=text` returns ordered route candidates with strike reasons for the requested model. It is read-only and makes zero provider calls.
- `GET /admin/api/models/visibility` returns per-model `{ id, visible, reasons[] }` entries using the same visibility rules as the dashboard.

`POST /admin/api/assistant/plan` creates a bounded comparison plan from a natural-language request. It returns only validated `chat`/`design` mode, one to four eligible physical lanes, optional generation parameters, an improved prompt, rationale, warnings, provider destinations, and cost class. Model IDs may repeat when independent samples of the same model are requested. Planning never executes inference comparisons or configuration mutations.

Assistant diagnosis uses a two-stage lazy resource request. The first model pass selects from an allowlist of dashboard resources; the final pass receives only those bounded API results. Raw request bodies are never available to this workflow.

Credential mutation is write-only:

- `PUT /admin/api/providers/:provider/credentials/apiKey`
- `DELETE /admin/api/providers/:provider/credentials/apiKey`
- OpenRouter also supports `managementKey`.

No credential endpoint returns key material or key-derived fragments. A successful credential mutation clears model health only for the affected provider (circuits, rate-limit windows, entitlement blocks, and latency state on that provider's models), so a rotated key takes effect immediately without resetting unrelated routes; the intentional full reset remains available at `POST /admin/api/circuits/reset`.
Committed-stream failures keep the already-sent HTTP `200` on the wire but are recorded with attempt outcome `committed_failure` (distinct from pre-commit `transient_error`) so metrics, history, and dashboard attempt rows distinguish provider truncation from fallback-eligible errors.
