# Changelog

## Unreleased

- Client-path in-flight shedding is now configurable via `maxInflightRequests` (default 64): concurrent client `/v1` requests beyond the bound receive a terminal `429` with `retry-after: 1` instead of stacking on upstream providers; internal Fieldbook/sandbox lanes are exempt.
- Virtual routes (`auto`/`best`/`free` and named custom cascades) now continue on upstream `429` while a different-provider candidate remains in the chain; explicit routes stay strict, and an exhausted chain surfaces a terminal `429` with the upstream `retry-after` preserved.
- Candidate-chain bookkeeping is now index-based rather than attempt-count-based, and the most recent upstream `retry-after` is forwarded on a terminal `fallback_exhausted` response, so a rate limit observed mid-chain is never dropped when the chain ends in transient failures or when a candidate was skipped.
- An upstream `usage.cost` of `null`, non-finite, or unparsable is treated as absent, so price-table estimation still runs instead of recording a reported $0.00; finite numeric and numeric-string costs keep their previous reporting.
- MIME content-type sniffing is now case-insensitive on the SSE, JSON-body, and catalog discovery checks (RFC 2045 type tokens), so intermediaries emitting `Text/Event-Stream` or `Application/Json` are accepted.
- Responses-API streamed events now rewrite the nested `response.model` on `response.created`/`response.completed`/`response.failed` frames (matching `x-router-model`) instead of adding a non-spec top-level `model` key to the event envelope.
- Streaming latency scoring now measures time to first output rather than whole-generation time, so long streams no longer inflate a model's latency score.
- Catalog reads no longer deep-clone models on every request: the service keeps frozen model views refreshed by rebuild, so `/v1` request paths avoid per-attempt `structuredClone` work; callers that try to mutate a returned model or its list now fail loudly instead of corrupting internal state.
- `POST /admin/api/sandbox` now reads up to 4 MiB of JSON (previously 1 MiB), so legal multi-branch max-size transcripts reach the per-transcript validators instead of being rejected by the shared admin body reader; other admin JSON endpoints keep the 1 MiB bound.
- The HTTP server now sets explicit connection timeouts (`keepAliveTimeout` 60 s, `headersTimeout` 120 s, `requestTimeout` 300 s) so agent keep-alive sockets survive between long tool turns; graceful shutdown first drains idle connections before the 5 s force timer, and a second SIGINT/SIGTERM exits immediately.
- Fieldbook Room turns are refunded when the provider or the per-turn deadline fails (matching Studio), while a user-caused pause or stop consumes the in-flight turn.
- Retained request bodies now expire after 24 hours (evicted lazily on retention of new content and on read) and `ROUTETOK_RETAIN_REQUEST_CONTENT=0` opts out of content retention entirely while the default stays on.
- The server verifies every allowlisted static asset at boot and refuses to start when any is missing from `public/`; a new dependency-free `scripts/smoke.mjs` boots the service and GETs `/healthz` plus every allowlisted module, and CI runs it after the build.
- Dashboard pages and modules now receive the full sandbox-tier Content-Security-Policy (`default-src 'self'` with explicit script/style/connect/img/media sources, `frame-ancestors 'none'`), and the single inline theme bootstrap was externalized into an allowlisted `theme-bootstrap.js`.
- `GET /healthz` now returns minimal liveness (`{"status":"ok"}`) and no longer echoes catalog state or upstream error strings; detailed status stays on the authenticated `/admin/api/status`.
- Image and audio upstream fetches no longer follow redirects: discovery metadata GETs treat redirects as errors and POST operations surface a redirected response as `502`.
- Image generation uses the same atomic single-flight acquire pattern as audio (check-and-set without an await window, released on every exit path).
- Credential changes now clear model health only for the changed provider (scoped `resetWhere`), so rotated keys take effect immediately without resetting unrelated circuits; the full reset at `/admin/api/circuits/reset` is unchanged.
- Half-open circuits now admit a single probe at a time and re-open immediately when that probe fails, is rate limited, or is entitlement-blocked; opening a circuit resets the inherited failure streak so the probe outcome is the sole decision point. The route simulator models the same gate.
- Committed streams no longer end silently on failure: post-commit upstream error frames are relayed (including flat Responses `type:"error"` events), and a stream that ends with an upstream error or without a terminal event receives a reason-accurate `stream_interrupted` error frame before the response ends, with `data: [DONE]` appended on OpenAI-Chat.
- The overall `requestTimeoutMs` deadline now detaches when a stream commits; post-commit responses are bounded only by the client connection and `streamIdleTimeoutMs`, so active streams can run past the deadline while idle streams end with the `idle_timeout` frame.
- Committed-stream failures are recorded with attempt outcome `committed_failure` (HTTP status stays 200 on the wire) so metrics and dashboard attempt rows distinguish post-commit provider truncation from pre-commit `transient_error`.
- Overall-deadline expiry during pre-output stream preparation no longer dispatches a phantom attempt on the next candidate.
- Sandbox model output is unlimited by default; an optional 1-64 MiB per-note cap can still be set.
- Added read-only admin endpoints `GET /admin/api/attempts/decode`, `GET /admin/api/route/simulate`, and `GET /admin/api/models/visibility` with dashboard authentication.
- Added dashboard Attempt Inspector, API Setup test request, onboarding wizard, and Fieldbook backup modules with script-tag mounts and static serving.
- Added docs/onboarding.md plus dashboard, API, README, and changelog pointers for the new operational workflows.

- Added the standalone Model Fieldbook with Chat, Compare, Room, Evaluate, Images, and Iteration Studio workspaces.
- Added explicit bounded cross-workspace context, a shared revisioned scratchpad, Roster Architect, branching, generated titles, artifact previews, and configurable sandbox output limits.
- Added browser-enforced Studio patch, handoff, review, steering, file-scope, revision, snapshot, rollback, and image-approval workflows.
- Added bounded image generation, OpenRouter speech, Requesty/local Speaches transcription, and ephemeral media handling.
- Added the static image-model benchmark gallery and expanded browser/integration coverage.
- Added scoped AgentRouter DeepSeek compatibility for historical Anthropic tool blocks.
- Unified Code, Canvas, and Scratchpad under concurrent modeless drawers and redesigned Studio so agent activity and steering use the remaining workspace.
- Focused the dashboard Support workspace on RouteTok operations and added a visible API setup and write-only provider-key management section.
- Moved runtime telemetry to the dashboard header area, removed the System card, hid unconfigured provider status cards, and added persisted Route Health model visibility and sorting controls.
- Converted API Setup into a dismissible drawer and added generated, hashed, individually revocable proxy client API keys alongside the existing environment key.
- Added a hardened multi-stage Docker image and loopback-only Compose deployment with persistent runtime state.
- Added a dedicated paid OpenRouter fallback order that preserves OpenRouter alternatives before AgentRouter last-resort routes.
- Documented and verified exact paid OpenRouter routing, pre-output retry boundaries, request preservation, terminal routing metadata, and focused Qwen diagnostics.
- Made failed catalog discovery retry after a short backoff instead of waiting for the normal freshness interval, while preserving the last usable catalog.
- Filtered `/v1/models` to configured, enabled, text-capable routes and made fallback capability checks reject only explicit incompatibilities while retaining candidates with unknown metadata.
- Added opt-in RouteTok model metadata schema v1 to `/v1/models?include=routetok` and corresponding scoped metadata on admin status, sandbox catalog, and image capability responses while preserving the strict-compatible default model list.
- Corrected model-entitlement `403` classification, Responses cache-token accounting, blank credit handling, managed-key internal authentication, concurrent key mutation safety, persisted metrics normalization, image request limits/status, and the default speech format.
- Hardened local and CI operations with isolated mock-only integration environments, bounded child-process teardown, recursive test discovery, Compose validation, Dockerfile checks, and retrying local STT model initialization.

## 0.1.0 - 2026-09-02

- Initial public RouteTok release.
- Multi-provider OpenAI/Anthropic routing and health-aware failover.
- Dashboard, metrics, sandbox, design catalog, custom cascades, configuration proposals, and write-only key management.
