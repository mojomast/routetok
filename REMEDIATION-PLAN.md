# RouteTok Remediation Plan

Derived from `AUDIT.md` (4 audit passes, HEAD `cddfbdf`, 2026-09-04) plus one independent
verification wave: six parallel read-only subagents re-checked every load-bearing claim
against the working tree (2026-09-04). This file is the actionable plan; `AUDIT.md` is the
evidence base. **No fixes are implemented yet.**

## Verification wave result

All ~80 consolidated claims were re-checked. **No claim was rejected.** Two were
downgraded, several refined. Load-bearing corrections baked into this plan:

| # | Correction (affects fix design) |
|---|---|
| V1 | Half-open: `consecutiveFailures` is never reset when the circuit opens or at the half-open transition (`router.ts`), so a circuit opened via the consecutive-failures arm re-opens on its FIRST probe failure already. The "3 failures to reopen" audit framing holds only for the windowed arm (which can trip at ≥5 samples, not 10). Fix must define handling of the inherited counter. Also the open→half-open flip is a side effect inside `candidates()`'s filter (`peek` hands back the live stored state at `router.ts:131,225-227`) — consider an explicit transition. `route-simulator.ts` re-implements filter + score and must change in lockstep (`test/unit/route-simulator.test.ts` `checkMatchesRouter` parity). |
| V2 | Commit-truncation family is really two silent cases + one loud-but-mislabeled: (1) flat `{type:"error"}` frames are byte-dropped; (2) clean EOF without a terminal event → clean end, no bytes; (3) `response.failed` IS forwarded (passes the `response.` predicate) but the stream ends without an error/terminal and is recorded 200 + `transient_error` (`finalStatus` stays 200 at `proxy.ts:1405` for all committed-stream failures — metrics understate). Error frames arriving pre-commit still fall back correctly. |
| V3 | Deadline truncation is not byte-silent: the overall-deadline abort destroys the committed body reader (signal wired into the fetch at `proxy.ts:1162`), the catch at `1635` writes the canned `stream_interrupted` frame; but pipeStream never checks the deadline itself, so behavior past `requestTimeoutMs` is transport-dependent. Fix = clear the overall timer in the synchronous commit path (at/near `writeHead` `proxy.ts:1602`). |
| V4 | `response.failed` and 200-`finalStatus`: metrics on committed-stream failures understate failures (see V2). Optional follow-up. |
| V5 | `attempt-summary` encode/decode round-trip is ALREADY covered end-to-end (`paid-fallback.test.ts:63-64` decodes the real header with deepEqual per scenario). Drop that test item. |
| V6 | `/metrics` IS fetched over HTTP in `audio-sandbox.test.ts:372` but only for secret redaction; format/prefix/TYPE never asserted. |
| V7 | Prod `test/` drift is larger than AUDIT.md named: 11 additional git-only/differing files (api-setup, attempt-inspector, onboarding-backup, attempt-summary, catalog-metadata, image-approvals, model-visibility, route-simulator, tool-transcript, dashboard-fieldbook, router tests). |
| V8 | `fieldbook/backup.js` is fully dead, not just dead-loaded: nothing in `public/` references `window.FieldbookBackup`; live import re-ids via `uid()` (`sandbox.js:1127`) so `mergeBundle` dedupe/sanitize paths are unreachable. Fix decision: delete the load + module, or wire it. |
| V9 | Attempt-inspector `buildReplayCurl` is at `attempt-inspector.js:137-151` (not ~410); header redaction is inline at curl build (name-pattern heuristic, `:146`); bodies emitted unredacted at `:149`; raw candidate payload stored at `:410-416`. |
| V10 | Redirect fix splits by method: GET metadata fetches (`admin-audio.ts:495,514`) → `redirect:"error"` like catalog/credits; POST fetches (`admin-images.ts:131`, `admin-audio.ts:307,400`) → `redirect:"manual"` like `proxy.ts:1187`. `"error"` on the POSTs degrades the specific error to a generic 502. |
| V11 | SVG gate is weaker than the regex list suggests: the leading structural regex `^(?:<\?xml[^>]*>\s*)?<svg` greedily absorbs an `<?xml-stylesheet?>` PI, so XSL/CSS active content (`@import`, xml-stylesheet, `<use>`, `<feImage>`, `<a xlink:href>`, `<image href>`) is the realistic bypass class. |
| V12 | Dashboard token direction: stored at `app.js:3404` (read at `:44`). Status polling: two timers — `/admin/api/status` 5 s / 1 s (`app.js:4472-4478`) AND a separate 500 ms `/admin/api/live` poller (`loadLive` `:2001`, `:4479-4485`). |
| V13 | Metrics error keys are uncapped in count AND in-memory length (the 1,000-char cap is load-side only, `metrics.ts:183-185`); distinct upstream-controlled keys accumulate until restart. |
| V14 | Sandbox 1 MiB body cap (`server.ts:184`) is a live user-visible limit today, not just a latent mismatch: legal 2-branch max-transcript bodies are rejected with 400. |
| V15 | Test-gap severity: 5 of the 8 never-HTTP-tested admin endpoints have NO coverage at any layer (attempts/decode, GET credits, credential PUT/DELETE, catalog/refresh, proposals/generate). Static frontend tests lock module CONTENT, not `index.html` wiring. |
| V16 | Room-vs-Studio refund asymmetry anchors: Studio failure refund at `sandbox.js:1042` (pause refund `:1036` is separate); Room consumes a turn on timeout failures (`:772-774`). |
| V17 | Working tree is not clean: `src/server.ts` has an uncommitted local `/next` allowlist/CSP change (out of scope per operator; must not be committed or blindly reverted — fixes should rebase onto HEAD `cddfbdf` semantics and tolerate ±20-line drift around `server.ts:1090-1180`). |
| V18 | Dashboard CSP tier is the only HTML tier with no test lock (sandbox/gallery tiers ARE locked in `proxy.test.ts:356,370,377`). |
| V19 | Prod is LIVE with doc/code contradiction: prod `server.ts` == git HEAD (unlimited sandbox output default) while prod `docs/api.md:90` still says "The default remains 4 MiB". |

---

## Working rules (from AGENTS.md)

- Implement in `/home/mojo/projects/agentrouterrouter-dev` only. Commit there. Never edit prod.
- Live-verify against isolated 8788 (`npm run dev:isolated`), never 8787.
- Quality gate per change: `npm run typecheck`, `npm test`, `npm run build`.
- Zero runtime dependencies; `node:test`; TypeScript strict; `.js` import suffixes.
- Docs (`docs/`) + `CHANGELOG.md` (Unreleased) + `test/` move in the same change for public behavior changes.
- Static-frontend tests (`test/static/frontend/*`) lock HTML/JS contracts — update in the same change.
- Smallest correct change; preserve legacy compatibility.

---

## Phase A — Critical correctness fixes (implementation-ready, highest leverage)

All three were live-verified in audit pass 4 (EXP1/EXP2/EXP3) and re-confirmed this wave.

### A1. Committed-stream truncation family — emit truthful terminal frames [HIGH]
Refs: P2-1 / N4-1 / N4-4 / N4-5. Files: `src/proxy.ts`, docs, tests.
- (a) Allow flat Responses error frames: add `type === "error" ||` to the allow predicate at `proxy.ts:644`. Prefix/event-line logic at `:648` already preserves the frame.
- (b) In `pipeStream` normal completion, when the inspector saw an upstream error (`response.failed`, flat error, or no-terminal EOF at `:1624-1634`), write a protocol-shaped error frame before `response.end()` instead of ending bare. Only reachable via a new branch — `writeStreamError` (`:913-928`) currently runs only from the catch (`:1635-1643`).
- (c) Make `writeStreamError` reason-accurate: coarse reason sub-field (`idle_timeout` / `deadline` / `reader_abort`) while keeping the `stream_interrupted` envelope (clients keep working). Never leak internals into `message`.
- (d) OpenAI-Chat: append `data: [DONE]` after the error frame (openai-node consumes `[DONE]` as a break; without it downstream routers treat the drop as a mid-stream error). Precedent: vLLM/LocalAI emit error + `[DONE]`.
- Note: `finalStatus` stays 200 for committed-stream failures (`proxy.ts:1405`) — record the transient properly (see A5).
- Tests: unit next to `router.test.ts:336-353` (flat error relayed; `response.failed` → frame + terminal; no-terminal EOF → frame). Integration: post-commit flat error via mock upstream.
- Docs: `docs/api.md` — document committed-stream error frames.

### A2. Detach the overall request deadline after stream commit [HIGH]
Refs: 2.2 / N4-2 / N4-8. Files: `src/proxy.ts`, `docs/api.md`, tests.
- Clear the overall `setTimeout` in the same synchronous commit path as `writeHead` (`proxy.ts:1602-1605`) — not via a later async callback (race). Keep the client-disconnect controller (`:1119-1128,1636`) and `streamIdleTimeoutMs` (`:1612-1616`) as the sole post-commit bounds.
- Keep the deadline for non-stream and pre-commit phases unchanged.
- `config.ts:67` clamp (max 600,000) stays; post-commit streams are then bounded by idle timeout only, so >10-min generations work while actively producing.
- Docs: `docs/api.md` timeouts section — state that the overall deadline applies until stream commit; after commit only idle time governs.
- Tests: integration with short `requestTimeoutMs` (child-server pattern, as EXP2): committed stream still producing tokens past the deadline must NOT be truncated; idle stream past deadline must produce the (now reason-accurate) idle frame.

### A3. Circuit breaker half-open single-probe + immediate re-open [MEDIUM-HIGH]
Refs: 2.1 / N4-6. Files: `src/router.ts`, `src/route-simulator.ts`, tests.
- (a) In `candidates()` (`router.ts:129-136`): admit a half-open model only when `state.inflight === 0` (single probe). `inflight` is maintained at `:160-167` from `proxy.ts:1163,1484` and balanced on all normal paths.
- (b) In `recordTransientFailure` (`:169-187`): if `circuitState === "half-open"`, immediately set `open` + refresh `circuitOpenUntil`, return (skip window accumulation).
- (c) `recordRateLimit` (`:193-197`) and `recordEntitlementFailure` (`:199-203`): same immediate re-open when half-open (otherwise a rate-limited/entitlement-blocked probe stays half-open forever).
- (d) Define the carried `consecutiveFailures` behavior (V1): zero it at the open transition or account for it in the probe-failure arm so the gate is the single decision point.
- (e) Optionally move the open→half-open flip out of the `filter` side effect into the explicit transition site (thread-safety/readability; see V1).
- (f) Lockstep: `route-simulator.ts:41-64` (`isBlockedByHealth` + `score` weights) must model the single-probe gate or the parity tests diverge.
- Tests: unit walk of expired-open → half-open → probe-fail → open; probe-success → closed; rate-limit/entitlement re-open; concurrent `candidates()` admission under half-open (mock timers OK — no real sleeps).
- Docs: `docs/api.md`/architecture if half-open semantics are described anywhere.

### A4. Phantom second attempt on overall-deadline expiry during prepareStream [MEDIUM]
Refs: P2-12 / N4-3. File: `src/proxy.ts`, tests.
- One line in the `prepareStream` catch (`:1351-1358`): after recording the attempt, `if (controller.signal.aborted) break;` else `continue;` (mirrors `:1211` and the non-stream `:1442` check). Prevents the spurious 502 attempt + transient failure on a model never contacted.
- Tests: integration with short `requestTimeoutMs` asserting `x-router-attempts` reflects only real upstream calls.

### A5. Metrics honesty for committed-stream failures [LOW-MEDIUM, small]
Refs: N4-1/V2/V4. File: `src/proxy.ts`/`src/metrics.ts`.
- Committed-stream failures currently record `finalStatus 200` + `transient_error` (`proxy.ts:1405-1411`). Decide a wire-truthful representation (e.g. status 200 kept for the HTTP layer but a distinct `committed_failure` outcome counted in metrics), so the dashboard/`/metrics` don't understate provider truncation.

---

## Phase B — Server reliability & performance

### B1. Cap SSE pending buffers [MEDIUM, rare trigger]
Refs: 2.3. `src/proxy.ts:571-580,603-615,695-700`. Cap `pending` length per event (flush/terminate with a stream error past ~4 MiB, mirroring the `pipeStream` error path). No blank-line-separated megabyte events allowed to accumulate.

### B2. Inspector meaningful-output generalization [LOW]
Refs: P2-3. `src/proxy.ts:670-674,740-763,784-791`. Treat any block-start/delta payload key beyond `type` with semantic value as meaningful (covers future `server_tool_use`, `web_search_tool_result`, citations deltas). Low trigger likelihood today; cheap future-proofing of the pre-commit window.

### B3. Anthropic sanitizer: log unknown event types [LOW, latent]
Refs: P2-2 (downgraded). `src/proxy.ts:652-666`. Keep the allowlist (forwarding unknowns risks model-field rewrite bypass); add a once-per-type counter/log when an unknown type is dropped so the next Anthropic event-type addition is visible instead of silent.

### B4. Candidate herding: jitter + windowed scoring [MEDIUM]
Refs: 2.4. `src/router.ts:138-142,229-237`. Add a small deterministic tie-break/jitter within a score band (±30) and compute the success-rate term from `recentOutcomes` instead of lifetime counters. Keep custom-cascade/paid-OR sort-skip semantics (`:138`).

### B5. Client-path in-flight shed [MEDIUM — policy + config decision]
Refs: 2.5. Mirror the sandbox pattern (`server.ts:735-739,763`) with a configurable ceiling for the client proxy traffic class returning 429 + `retry-after`. Requires new config bounds in `config.ts`.

### B6. Retry-after survives skipped candidates [LOW]
Refs: P2-9. `src/proxy.ts:1150,1223,1284,1488-1512`. Index-based remaining test or forward the last-seen upstream `retry-after` in the `fallback_exhausted` fallthrough.

### B7. `cost: null` treated as absent [LOW]
Refs: P2-10. `src/proxy.ts:262,299-302`. Treat non-number/non-finite `cost` as `undefined` so estimation still runs.

### B8. Case-insensitive content-type sniffing [LOW]
Refs: P2-8. `proxy.ts:857,1423`; `catalog.ts:497`. Lowercase before `includes`.

### B9. Responses model substitution: rewrite nested `response.model` [LOW]
Refs: P2-7. `src/proxy.ts:647`. On the Responses wire, rewrite `value.response.model` when present; skip the envelope assignment. (Non-stream `:1463` correct as-is.)

### B10. Same-provider fallback backoff / honor retry-after [LOW — design call]
Refs: 2.7b / B12. Small jitter or `retry-after` honoring between same-provider candidates in custom cascades. Optional; confirm value before building.

### B10a. 429 cascade continuation for virtual routes [MEDIUM — DECIDED Q1]
Refs: 2.6. `src/proxy.ts:1218-1241`. For virtual (`auto`/`best`) and custom-cascade requests only, continue the candidate chain on upstream 429 while a different-provider candidate remains; preserve the current `retry-after`/terminal headers when exhausted (pattern already exists for the paid-OR chain). Explicit single-model routes stay strict (documented policy). Update `docs/api.md` fallback rules and the integration tests that lock 429 semantics.

### B11. Image-generation gate: atomic acquire [LOW/MEDIUM — paid-spend path]
Refs: P2-4. `src/admin-images.ts:115-126,151`. Synchronous check+set at top of `generate()` (the `admin-audio.ts:440-444` `acquire()` pattern), released in the outer finally.

### B12. Scoped health reset on credential change [LOW/MEDIUM]
Refs: P2-5. `src/router.ts:205-207`, `src/server.ts:1435`. Add `resetWhere(predicate)` scoped to the changed provider's models; keep the intentional full reset at `/admin/api/circuits/reset` (`server.ts:1582-1585`).

### B13. Content-retention TTL + opt-out [LOW — roadmap P3]
Refs: P2-13, A#15. `src/proxy.ts:975-993`. TTL eviction on insert (`capturedAt` already stored, never consulted) and optional `ROUTETOK_RETAIN_REQUEST_CONTENT=0`. Decision: keep default-on with bounds per current posture.

### B14. Streaming latency uses first-output time [LOW]
Refs: P2-11. `src/proxy.ts:1414`. Pass `firstOutputMs ?? Date.now() - started` into `recordSuccess` so long generations don't penalize the score.

### B15. Audio transcription body: avoid byte-at-a-time copy [LOW]
Refs: P2-P2. `src/admin-audio.ts:361`. Pass a proper Buffer view (respect byteOffset) instead of `Uint8Array.from(bytes).buffer` iterator copy.

### B16. Stop cloning the catalog on read paths [LOW today / MEDIUM at scale]
Refs: 4.1. `src/catalog.ts:378-392`; callers `proxy.ts:1063,1392,1466`. Return frozen internal arrays or precomputed per-protocol views refreshed in `rebuild()` (`catalog.ts:537-539`). Verification confirmed no caller mutates results. Keep `config.get()`'s clone.

### B17. `/admin/api/status` catalog embed: revisioned endpoint or projection [MEDIUM at scale]
Refs: P2-P1 / N4-7. `src/server.ts:1328-1331` + `public/app.js` (dashboard pollers `:4472-4478` and the separate 500 ms `/admin/api/live` `:4479-4485`). Do NOT strip `models` (≥10 `catalogModels()` consumers incl. `app.js:1941` which reads `payload.catalog.models.length` directly). Options: (a) revisioned `GET /admin/api/catalog` with `If-None-Match` reusing the `configRevision` pattern, or (b) `?fields=` projection. Dashboard work bundled with Phase D.

### B18. Sandbox 1 MiB body cap vs documented transcript bounds [LOW — live today]
Refs: P2-6 / V14. `src/server.ts:184` vs `sandbox-tools.ts:4-5` + 4 branches (`server.ts:229-231`). Dedicated ~4 MiB reader for `/admin/api/sandbox`, or lower/document per-branch caps. Align `docs/fieldbook.md` + `docs/api.md`.

### B19. Node server hardening bundle [LOW]
Refs: 4.4. `src/server.ts:1174` (`createServer`), `:1603-1615`, `:1617-1618`. Explicit `keepAliveTimeout`/`headersTimeout`/`requestTimeout`; `closeIdleConnections()` before the 5 s force timer on shutdown; second-signal force-exit. SSE-safe (requestTimeout governs request reception only).

---

## Phase C — Security

### C1. Dashboard CSP tier [MEDIUM]
Refs: 3.1 / V18. `src/server.ts:1153-1161` (else-branch tier = `frame-ancestors 'none'` only).
- Externalize the single inline theme bootstrap (`public/index.html:8-46` — exactly one inline script, zero inline handlers) into an allowlisted file.
- Give dashboard paths the sandbox-tier policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- Add the missing CSP-tier static test (lock the dashboard tier alongside `proxy.test.ts:356,370,377`).
- Note: `/next` additions in the local working tree are out of scope (operator decision stands).

### C2. `/healthz` minimal + detailed status stays admin-only [LOW/MEDIUM]
Refs: 3.6. `src/server.ts:1185-1188`, `catalog.ts:394-420,531`. Return `{status:"ok"}`-class liveness from `/healthz` (optionally readiness split — see roadmap); keep detailed catalog status on `/admin/api/status`. Also bounds the echo at `server.ts:1439-1442` and the `/admin/api/status` catalog spread (`:1328-1331`).

### C3. Origin-gate parity on unauthenticated GETs [LOW]
Refs: 3.5. `src/server.ts:1190-1203,1225-1235` vs the POST/admin gates (`:1211,1238`). When the no-credential loopback fallback is active, apply `browserOriginAllowed` (or require loopback `Host`) to `GET /v1/models` and `GET /metrics`. Real exposure is low (keys off ⇒ loopback-only anyway) — defense-in-depth.

### C4. Redirect discipline on image/audio fetches [LOW]
Refs: 3.3 / V10. GETs `admin-audio.ts:495,514` → `redirect:"error"`; POSTs `admin-images.ts:131`, `admin-audio.ts:307,400` → `redirect:"manual"` (then treat 3xx as 502). Test the 3xx→502 mapping.

### C5. SVG gate: tighten negatives [LOW]
Refs: 3.2 / V11. `src/admin-images.ts:54`. Also reject `xml-stylesheet`, `style`/`@import`, `a`/`image`/`use`/`feImage` with external refs, `javascript:`/`data:` hrefs. Render-boundary rule (`sandbox.js` sandboxed iframes + CSP) remains the enforcement point; never serve generated SVG as a top-level document.

### C6. Generic-provider SSRF posture [LOW; MEDIUM when ALLOW_PRIVATE=true]
Refs: 3.4. `src/server.ts:68-76` — the private flag gates only the scheme, never the host. When `GENERIC_OPENAI_ALLOW_PRIVATE=true`, `dns.lookup` at startup and reject non-private-resolving names (zero deps). Otherwise strengthen the documented trust assumption.

### C7. Request `storage.persist()` in the Fieldbook [LOW]
Refs: P2-S2. `public/sandbox.js` init: request `navigator.storage.persist()` once; surface granted/denied beside the quota meter.

### C8. Cosmetic header alignment [INFO]
Refs: 3.9. Add `x-content-type-options: nosniff` to the generic `json()` helper (`src/server.ts:168-176`).

---

## Phase D — Frontend / Fieldbook

### D1. IndexedDB connection hygiene [LOW/MEDIUM]
Refs: P2-F1/F2 / V-live. `public/sandbox.js:64-87,130-135`.
- Memoized single connection + `onversionchange` close; batch `enforceCaps` deletes into one `readwrite` transaction on an interval, not per save.
- `.catch(toast)` on the immediate-save sites (`:140,742,748,775,1043,1197`, plus the `:1173` delete handler).
- Static tests: `test/static/frontend/*` may lock the new helper names.

### D2. Wire the dashboard/backup modules into the UI [MEDIUM — DECIDED Q2]
Refs: 8.2 / P2-F3/F4 / V8. `public/app.js`, `public/sandbox.js`, `public/fieldbook/backup.js`.
- Dashboard: mount `window.AttemptInspector`, `window.ApiSetup`, `window.Onboarding` in `app.js` where `docs/dashboard.md:59,63` and `docs/onboarding.md:3,6` claim they live (native implementations for client keys/proposals already in `app.js` may need to yield or coexist — check before duplicating).
- Fieldbook: wire `window.FieldbookBackup` export/import UI in `sandbox.js`; route live `exportJson` (`sandbox.js:1097`) through `exportBundle` + `sanitizeRecord`; give `mergeBundle` revision-newer-wins + a `skippedOlder` tally (live import already re-ids via `uid()` at `:1127` — safe).
- Add wiring assertions to `test/static/frontend/*` (today they lock module content only, not `index.html` wiring — V15).
- Docs stay accurate; prod drift for these four files disappears with the F7 deploy (already allowlisted).

### D3. Agent-loop abort/approval races [MEDIUM/LOW, latent]
Refs: P2-F5. `public/fieldbook/agent-loop.js:67-129`, `sandbox.js:669`, `tool-approvals.js:4-11`.
- Re-check the abort signal after each await (`authorize` `:71`, `requestApproval` `:81`) and before `execute` `:107`; pass the signal into `execute`; on abort, stub every unanswered call in the batch (`pendingCalls` handling `:70,125-129`); `authorize` inside try/catch.
- Latent today because `ask()` never rejects — it becomes live the moment any future approval gate rejects. Fix the loop regardless.

### D4. Live Room/conversation growth caps [LOW]
Refs: P2-F6. `sandbox.js:741,773-774` vs import-only caps `:1116-1120`. Apply the same bounds on live append.

### D5. Dashboard `api()` error handling [LOW]
Refs: P2-F7. `app.js:326` — check `!response.ok` before `response.json()` (mirror `audioFetch :336-354` / `sandbox.js:99`).

### D6. Sanitizer attribute-list unification [LOW]
Refs: P2-F8. `sandbox.js:296-299` vs `:993-996`. One shared deny list incl. `srcset/formaction/srcdoc` on both paths (no exploit today: `sandbox=""` + `default-src 'none'`).

### D7. Room refund policy [LOW — design decision]
Refs: 2.7a / V16. Room consumes a turn on duration-limit failures (`sandbox.js:772-774`); Studio refunds (`:1042`). Decide parity; if refunding on provider/deadline failure, key on `:1042`'s pattern.

### D8. UX/a11y polish bundle [LOW/note]
Refs: N-U1. Toast queue + `role="alert"` for errors; focus management on `setMode` (`:1129`) and turn completion; 1-deep undo buffer; contrast verification for `--muted`, `#c47750`, `#d8c89e`; settings-rail visibility (`sandbox.css:37` suppresses `.settings` at 901–1400 px — confirm intent); forced-colors text labels. No blockers; batch as polish.

---

## Phase E — Test debt (add to the suite with the related fix where possible)

Confirmed absent this wave (see AUDIT.md §5 and pass-2/4 additions). Round-trip item (T20) is dropped (V5); `/metrics` fetch exists but needs format assertions (V6).

| ID | Test | Effort |
|---|---|---|
| E1 | Half-open single-probe: expired-open → half-open → probe-fail re-open / probe-success close; rate-limit & entitlement re-open; concurrent admission (with A3) | S |
| E2 | Overall-deadline abort: committed stream survives past deadline while producing; idle past deadline → reason-accurate frame (with A2); phantom-attempt regression (with A4) | M |
| E3 | SSE split-invariance: export `StreamSanitizer`/`streamEventBlocks` from `proxy.ts`, add seeded split-at-every-byte harness + CRLF/blank-line edges + no `billing.*` leakage | M |
| E4 | `t.mock.timers` for metrics save debounce and half-open transitions (no real sleeps) | S |
| E5 | Allowlist-vs-disk static test (parse `staticFiles`, assert presence) + boot-time check (with F1) | S |
| E6 | `GET /healthz` shape/redaction test | S |
| E7 | Origin-gate tests: send `Origin` headers; wrong-credential 401s; env-key + managed-key auth | S |
| E8 | Sandbox concurrency shed: 429 + `retry-after: 1` (server) and audio acquire-429 | S |
| E9 | `writeStreamError` synthesized mid-stream frame (bytes + `[DONE]` after A1) | S |
| E10 | `retry-after` HTTP-date form and clamp bounds (fixtures use only `"1"`) | S |
| E11 | Prometheus golden/format test: dual-prefix parity, HELP/TYPE pairing, TTFT naming, label escaping | S |
| E12 | HTTP coverage for the 8 admin endpoints (5 have zero coverage at any layer — V15) | M |
| E13 | `admin-images` deep paths (bad aspect/quality/format; model-not-enabled); audio odd-length PCM 502 | S |
| E14 | Legacy `/messages` alias over HTTP | S |
| E15 | `getModels()` immutability contract (cheap once B16 lands; tautological today) | S |

---

## Phase F — Deployment, CI, docs

### F1. Boot-time static-asset verification + smoke script [MEDIUM, deployment]
Refs: 2.8 / P2-D1 / V7. Insert the check right after the `staticFiles` literal (HEAD `server.ts:1123`); verify every listed file exists under `publicDir` at boot and refuse to start (or loudly log) on missing files. Add `scripts/smoke.mjs` GETting every allowlisted module (dependency-free; fits `scripts/` pattern). This kills the live prod-500 class.

### F2. CI boot smoke [LOW]
Refs: P2-D1. `ci.yml` (22 lines; compose `config --quiet` + `buildx --check` only). Add a boot-and-GET smoke reusing the `test/support/process.ts` child-server pattern (allowlist-vs-disk check catches the prod drift class in CI).

### F3. Supply-chain pinning [LOW]
Refs: P2-D2, A#20. SHA-pin `actions/checkout`/`actions/setup-node`; Dependabot `docker` + `github-actions` ecosystems; digest-pin Dockerfile base (`node:22.19.0-alpine3.22`); consider mem/pids limits on the main compose service (matches `deploy/local-stt/compose.yml`, which is already digest-pinned).

### F4. `/metrics` documentation [LOW]
Refs: P2-D3. Document family names, dual-prefix policy, and the future single-prefix migration in `docs/api.md` (the only `routetok_` docs hit is a compose volume name).

### F5. Doc mismatch batch [LOW]
Refs: P2-D4, 8.3, V19. In one change: `docs/api.md:90` 4 MiB → unlimited (live contradiction in prod today); `docs/architecture.md:43-44` duplicated bullets; `docs/troubleshooting.md` add the 500 "Dashboard assets are unavailable" mode; `docs/configuration.md` Routing Policy defaults/bounds; CHANGELOG Unreleased wording; benchmark script path mismatch (`:208` vs `:259`); remove/keep unreferenced `docs/images/*.png` (2, ~254 KB); `package.json` description; CSP-language drift note (docs say distinct policies exist — they don't yet; resolve with C1). See also F6.

### F6. Dashboard module wiring — implementation tracked in D2 [MEDIUM, docs/code drift]
Refs: 8.2. Decision Q2 = wire the modules into the UI (D2). `docs/dashboard.md:59,63`, `docs/onboarding.md:3,6` already document the workflows; after D2 lands they describe reality again. Update static tests to lock the `index.html` wiring (currently locked only for module content — V15).

### F7. Prod drift sync [OPERATIONAL — deferred, gate on operator]
Refs: 8.1 / U-3 / V7. Decision Q7: **deploy only after the operator is explicitly re-asked when the fix set is ready** (to confirm nothing is in flight). When triggered: sync `public/index.html` + the module files together (never separately — `?v=` version strings), plus the `src/` fixes from Phase A/B and docs/test lag; quarantine/delete prod leftovers (`public/dashboards/`, `frontend/dashboards/`, top-level `studio-chat.js`/`image-approvals.js` duplicates, `scripts/build-dashboards.mjs` which imports esbuild — not a devDependency); verify `/healthz`, `/v1/models`, `/dashboard`, `/sandbox` on 8787 in coordination with active agent sessions.

### F8. Ops knowledge tracking [LOW]
Refs: 8.1f / 8.3. Consider committing `AGENTS.md` (or a `CONTRIBUTING` pointer) and this plan + `AUDIT.md` so the ops/audit knowledge travels with the repo.

---

## Resolved decisions (operator sign-off, 2026-09-04)

| # | Decision | Resolution | Effect on plan |
|---|---|---|---|
| Q1 | 429 cascades | **Yes — virtual routes only.** `auto`/`best` and custom cascades continue on 429 while a different-provider candidate remains; explicit routes stay strict. | Re-scopes 2.6 → active change in Phase B (proxy.ts:1218-1241 + docs/api.md + fallback tests). Retry-after/terminal headers preserved when the chain exhausts (already implemented for the OR chain). |
| Q2 | Dead-loaded modules | **Wire them into the UI** where the docs claim (dashboard mounts for AttemptInspector/ApiSetup/Onboarding in app.js; `backup.js` export/import wired through `exportBundle`/`sanitizeRecord`). | Re-scopes D2/D4/F6 → active frontend work; keep the files, add mounts + tests; docs stay accurate after wiring; prod drift is fixed by the eventual F7 deploy (files already in allowlist). |
| Q3 | Client-path in-flight shed | **Yes, configurable**, default ~64 concurrent proxy requests, 429 + `retry-after` beyond it. | B5 confirmed with a new config bound + tests. |
| Q4 | Room refunds | **Refund on infra/provider failure** (deadline, fallback exhausted); user-caused stops still consume the turn. | D7 confirmed at sandbox.js:772-778, Studio parity keyed on :1042. |
| Q5 | Spend guardrails | **Park until after Phase A** (depends on trustworthy cost reporting, B7). | Stays roadmap P2. |
| Q6 | Content retention | **TTL 24 h + `ROUTETOK_RETAIN_REQUEST_CONTENT=0`**, default-on preserved. | B13 confirmed at proxy.ts:975-993. |
| Q7 | Prod drift sync | **Deferred — operator to be asked again when the fix set is ready to deploy** ("ask me when it's time, to make sure nothing is in flight"). | F7 gate: do not deploy until the operator is re-asked at that point; sync scope re-confirmed then. |
| Q8 | `/next` working-tree work | **Move to a `wip/next` branch** in dev so main stays clean for Phase A commits. | Housekeeping step 0 before any Phase A commit. |

No open decisions remain for Phase A. Q2/Q3/Q4/Q6 decisions unblock the listed Phase B/D items; Q1 adds a new Phase B item (B10a).

---

## Suggested execution order

1. **Housekeeping (Q8):** move the `/next` working-tree changes (`src/server.ts` hunks + `public/next/`) to a `wip/next` branch in dev so `main` is clean for fix commits. No deploy anywhere.
2. **Phase A (A1→A4→A2→A5)** with their tests — server-only, zero risk to frontend, all evidence-backed, kills the only active client-visible data-loss class. Run the gate; verify against 8788.
3. **Phase E tests that lock Phase A** (E1/E2/E9/E10) — do not defer past the Phase A PRs.
4. **Phase C security (C1/C2/C4) + B11 (image gate) / B12** — small, high clarity.
5. **F1/F2 boot checks** — then the prod-500 class is dead in both dev and CI before any deploy.
6. **Phase B remaining (incl. B5 shed, B10a 429 cascade, B13 retention TTL)** + **Phase D frontend** (incl. D2 module wiring, D7 refund) — batch per file; Fieldbook/dashboard items are browser-only (verify against 8788 in a real browser).
7. **Phase F docs/drift** — after the above so docs describe reality; the prod deploy gate (F7) then requires re-asking the operator (Q7) before anything touches 8787.
8. Park roadmap P3 items (spend guardrails, catalog refresh parsing `pricing.overrides`, alert webhook) until the above is green.
