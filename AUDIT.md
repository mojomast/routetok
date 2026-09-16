# RouteTok Audit Report

Comprehensive, evidence-backed audit of the RouteTok LLM router (`github.com/mojomast/routetok`, main `cddfbdf`, 2026-09-04). Read-only audit: no code was modified.

**Methodology.** Full project read (README, CHANGELOG, `docs/`, all of `src/`, all of `public/`, all of `test/`, packaging/CI, git history), prod↔dev drift diff, plus six parallel best-practice/prior-art research workstreams (wire-protocol conformance, router architecture, security, performance, observability/ops, comparable open-source routers). Findings below carry `file:line` evidence against this checkout (the git dev copy, canonical). Findings that were verified by delegated deep-read subagents but that I did not personally re-read are marked `[subagent-read]`. Production references (`/home/mojo/projects/agentrouterrouter`) are explicit. No secrets or env values appear in this report.

**Constraints honored in every recommendation:** zero runtime dependencies (Node built-ins only), `node:test`, local-first loopback posture, no bodies in metrics/retention (beyond the existing bounded memory-only inspection buffer), legacy AgentRouter alias compatibility, smallest correct change.

---

## 1. Executive summary — top 10 highest-leverage findings

1. **Half-open circuit admission is a stampede, not a probe** — `router.ts:129-136` flips `open → half-open` on the first post-cooldown request and then lets every concurrent request through; a single failed probe does not re-open the circuit (`router.ts:179-187` needs 3 consecutive failures or ≥50% of a 10-outcome window). Concurrent `auto`/virtual requests can all hit a still-down model. Fix is a one-line inflight admission rule in half-open. (Section 2.1)

2. **The 600s overall deadline hard-terminates committed SSE streams even while tokens flow** — `proxy.ts:1115-1117` + `1162` attach the request-deadline controller to the upstream fetch for the *entire* attempt, including the post-commit streaming phase (`pipeStream`, `proxy.ts:1586-1645`). A generation longer than `requestTimeoutMs` (max 600s, `config.ts:67`) is truncated mid-token. Long reasoning/streaming responses need the deadline detached after commit. (Section 2.2)

3. **Prod is serving a dashboard frontend that 500s on module requests and cannot run the dashboard modules git ships** — prod `public/` lacks `api-setup.js`, `attempt-inspector.js`, `onboarding.js`, `fieldbook/backup.js`, which are in the `staticFiles` allowlist (`server.ts:1100-1123`) → 500 for those URLs; prod `index.html` also omits their script tags. Root cause of the whole drift class: allowlist entries are only checked at request time; there is no boot-time existence check and no smoke test. (Sections 2.8, 8.1)

4. **The dashboard CSP tier is effectively absent** — `/`, `/dashboard`, `/app.js`, `/styles.css` fall through to `"frame-ancestors 'none'"` only (`server.ts:1146-1153`); no `default-src`/`script-src`. The dashboard holds the admin token in `localStorage` (`app.js:44,3404`) and renders model/provider text, so any XSS would be unmitigated. Fix: externalize the inline theme script in `public/index.html:8-45` and add a real CSP tier. (Section 3.1)

5. **Non-stream and pre-output fallback semantics are correct and unusually well-tested** (retry only before output, 256 KiB pre-commit buffer, stream-commit terminal headers, 429 paid-OR cascade) — this is the project's crown-jewel invariant set and the audit found no violation. Documented best practice (Anthropic/OpenAI retry semantics) matches the implementation. (Section 2.0 — confirmations)

6. **Per-request catalog cloning sits on the pre-TTFT critical path** — `catalog.getModels()` deep-clones the whole catalog (`catalog.ts:378-383`) on every inference request (`proxy.ts:1063`) plus twice more after success for pricing (`proxy.ts:1392,1466`) and `resolve()` per attempt (`proxy.ts:1147`; `catalog.ts:389-392`); measured ~10 ms + ~3 MB garbage per 3,000-entry clone. Only matters when live catalogs are large (OpenRouter), but the fix is trivial (freeze internal arrays / precomputed per-protocol views). (Section 4.1)

7. **`/healthz` — the only unauthenticated endpoint — echoes per-provider catalog error strings** (`server.ts:1177-1180` → `catalog.status()` → raw `lastError` messages, `catalog.ts:404-415,531`), which can embed URLs/account hints. Docker `HOST=0.0.0.0` (Dockerfile) exposes it beyond loopback when published. (Section 3.6)

8. **No upstream in-flight cap or shed exists on the client proxy path** (only the sandbox has 429 shedding: `server.ts:735-739`) and dynamic candidate scoring is deterministic, so concurrent `auto` requests herd to one winner then oscillate (`router.ts:138-142,229-237`). A tiny random tie-break + optional per-provider concurrency cap would fix the known herding failure mode. (Sections 2.4, 2.5)

9. **SSE `pending` buffers in the sanitizer and inspector are unbounded per event** (`proxy.ts:603-607,695-698` with `streamEventBlocks` splitting only on blank lines) — a misbehaving upstream streaming megabytes without `\n\n` grows memory with no ceiling, unlike the bounded 256 KiB pre-commit buffer. (Section 2.3)

10. **Metrics/Prometheus divergence debt**: every family is emitted twice (`routetok_` + `agentrouter_router_`, `metrics.ts:525-526`); per-model families lack `# TYPE`/`# HELP` (`metrics.ts:507-523`); TTFT count is named `ttft_samples_total` not `ttft_seconds_count` (`metrics.ts:491`), breaking the `_sum`/`_count` pairing convention; request-duration totals are tracked but never exported. Mostly low severity but cheap to fix, and dual-prefix emission doubles cardinality forever. (Section 4.3 / 7.2)

---

## 2. Correctness & reliability issues

Each finding: evidence, impact, smallest correct change.

### 2.1 Circuit breaker half-open semantics

- Evidence: `router.ts:129-136` (open→half-open transition and admission), `router.ts:146-158` (`recordSuccess` force-closes and clears `rateLimitedUntil` on any success), `router.ts:169-187` (opening rules: consecutive ≥ threshold OR windowed failure-rate ≥ 0.5 at ≥ minimumSamples), defaults `config.ts:15-18`.
- Research comparison: Hystrix lets exactly one request through in HALF-OPEN and reopens on that probe's failure; Resilience4j bounds `permittedNumberOfCallsInHalfOpenState`; Envoy outlier ejection probes one host [Hystrix wiki; Resilience4j docs; Envoy outlier docs].
- Impact: during recovery from an outage, N concurrent virtual/cascade requests all pass the half-open check (state is not `open` anymore) and hit a model that may still be down. Reopening requires 3 more consecutive failures, so the stampede persists until the circuit reopens or a success closes it. Also `recordRateLimit`/`recordEntitlementFailure` never re-open a half-open circuit.
- Smallest fix: (a) in `candidates()`, when `circuitState === "half-open"`, admit only when `state.inflight === 0` (single probe); (b) in `recordTransientFailure`, if `circuitState === "half-open"`, immediately set `circuitState = "open"` and refresh `circuitOpenUntil`.

### 2.2 Overall request deadline kills committed streams

- Evidence: overall deadline `setTimeout(..., config.requestTimeoutMs)` `proxy.ts:1115-1117`; `AbortSignal.any([controller.signal, attemptController.signal])` `proxy.ts:1162`; the same `controller` stays attached through `pipeStream` (which reads with only an idle timeout `proxy.ts:1612-1616`). `requestTimeoutMs` bounded to 600,000 ms (`config.ts:67`), default 600,000 (`config.ts:10`). `attemptTimeout` is cleared right after `prepareStream` (`proxy.ts:1359-1361`), but the overall controller is never cleared on commit.
- Impact: any stream that has been running >10 min from request start is hard-truncated with a "request deadline exceeded" mid-stream error even while actively producing tokens. Non-stream responses and pre-commit phases correctly need the deadline.
- Smallest fix: phase the signal — keep the overall deadline only until `stream_committed` (writeHead in `pipeStream`, `proxy.ts:1602-1605`), then detach it. Since `AbortSignal.any` cannot be unregistered, use a small forwarding controller that stops forwarding `abort` from the overall timer once the commit point passes; leave `streamIdleTimeoutMs` as the sole streaming bound. Update `docs/api.md` if behavior is documented.

### 2.3 Unbounded SSE pending buffers

- Evidence: `StreamSanitizer.push/finish` (`proxy.ts:603-615`) and `StreamInspector.push` (`proxy.ts:695-700`) accumulate `this.pending += decoder.decode(...)` and only drain on `\n\n` (or `\r\n\r\n`/`\r\r`) separators (`streamEventBlocks`, `proxy.ts:571-580`). No cap exists on a single unterminated event; contrast with the deliberate 256 KiB pre-commit cap (`proxy.ts:19,878`).
- Impact: a buggy or hostile upstream that streams data without blank-line framing grows `pending` without bound (bounded only by the 600 s deadline). Each accumulated event is also `JSON.parse`d + re-stringified.
- Smallest fix: cap `pending.length` (e.g. flush/terminate with a stream error past ~4 MiB, mirroring the error path in `pipeStream`).

### 2.4 Deterministic candidate re-sort herding; score uses lifetime counters

- Evidence: sorting per request by identical `score()` (`router.ts:138-142`); `score` uses lifetime `successes/failures` (`router.ts:233-234`) with the windowed `recentOutcomes` used only for the circuit arm (`router.ts:176-181`); `inflight` is only incremented *after* selection (`startAttempt` in `proxy.ts:1163`), so the `-inflight*140` penalty cannot prevent same-instant herding. Latency term saturates at 50 points vs a 1,000-point order bias (`router.ts:235`).
- Impact: concurrent requests for `auto`/`best` all pick the same top candidate at the same instant, then the winner flips between iterations (oscillation). Success rate is dominated by stale lifetime history rather than recent behavior.
- Research comparison: Envoy's P2C ("pick of 2") and weighted least-request exist precisely to avoid herding [Envoy LB docs].
- Smallest fix: add a small deterministic-tie-break/jitter when candidate scores are within a band (e.g. ±30), and compute `successRate` from `recentOutcomes` instead of lifetime counters.

### 2.5 No global or per-provider in-flight cap on the client proxy path

- Evidence: only sandbox inference is capped (`activeSandboxRequests`, `server.ts:735-739,841,897`); image/audio have `active=1` (`admin-images.ts:115`) and 2 (`admin-audio.ts:440-444`). Client proxy traffic is uncapped; `startAttempt` inflight is used only for scoring (`router.ts:160-167`).
- Impact: with `HOST` exposed, a burst of concurrent requests fans out unboundedly to paid providers. Even locally, unbounded upstream fan-out from many simultaneous agent requests has no backstop.
- Research comparison: Envoy per-cluster `max_active_requests` circuit breakers and retry budgets [Envoy circuit_breaking docs]; LiteLLM cooldowns/`allowed_fails`.
- Smallest fix: an in-process counter returning `429`/`503` beyond a configurable ceiling, mirroring the existing sandbox pattern (dependency-free), scoped to the client traffic class.

### 2.6 Non-429 rate limits stop cascades that have healthy siblings

- Evidence: on upstream `429`, only the paid-OpenRouter chain continues (`proxy.ts:1218-1241`); virtual `auto`/cascade requests with a healthy different-provider sibling behind the rate-limited model return 429 immediately.
- Impact: a 429 on the #1 ranked model of `auto` degrades the whole request even when the next candidate is a different provider with capacity. Note this is documented behavior (`docs/api.md` §paid-OR; config knob `fallbackExplicitModels` deliberately keeps explicit routes strict) — for *virtual/cascade* requests it is arguably a miss rather than policy.
- Smallest fix (policy decision first): for virtual/custom-cascade requests only, continue the chain on 429 when a different-provider candidate remains, preserving the current `retry-after`/terminal headers when exhausted (already implemented for the OR chain).

### 2.7 Fallback loop behavior details worth confirming

- Room: a per-turn deadline failure posts "Turn failed…" and continues without refunding the consumed turn (`sandbox.js:772-778`), while Studio refunds (`sandbox.js:1036`). Intentional asymmetry per docs, but a flaky provider silently drains a Room budget; verify desired behavior. [updated — see Audit pass 2 (2026-09-04): verified; the Studio refund line is 1042, not 1036]
- Attempt loop advances with zero delay between candidates (`proxy.ts:1146-1486`). Fine across providers; when a custom cascade targets several models on the *same* provider, honoring a small backoff/jitter (or upstream `retry-after` on 5xx) would be kinder and matches common practice (AWS jitter guidance).
- `recordSuccess` clears `rateLimitedUntil` unconditionally (`router.ts:152`) — a single success on a different model never affects this model, but a success on the rate-limited model itself immediately clears a still-valid cooldown; verify intent.

### 2.8 Deployment-correctness: allowlist entries are 500s when files are missing, checked only at request time

- Evidence: `serveStatic` reads from disk per request and 500s on any read error (`server.ts:1140-1163`); the allowlist (`server.ts:1100-1123`) currently lists `api-setup.js`, `attempt-inspector.js`, `onboarding.js`, `fieldbook/backup.js` which are absent from prod disk → 500s (confirmed by directory listing of `/home/mojo/projects/agentrouterrouter/public`).
- Impact: exactly the live-prod failure mode described in AGENTS.md; silent until a browser requests the URL.
- Smallest fix: at boot, after building `staticFiles`, verify each listed file exists under `publicDir` and `console.error` (or refuse to start) for missing files. Also add a `scripts/smoke.mjs` that GETs every allowlisted module and asserts 200 (fits the existing dependency-free `scripts/` pattern).

### 2.9 Verified-correct invariants (kept, no action)

- Pre-output fallback: buffered pre-commit window with first-output deadline and 256 KiB metadata cap (`proxy.ts:851-891`); commit on semantic text/reasoning/refusal/tool output (`proxy.ts:744-792`); later failures stay on the committed stream (`proxy.ts:1596-1645`), producing a protocol-shaped mid-stream error (`writeStreamError`, `proxy.ts:913-928`).
- Request-body preservation across attempts with only `model` substituted (`proxy.ts:1178`) and the DeepSeek/thinking transforms scoped to Anthropic (`proxy.ts:1170-1177`; `stripThinkingForFallback`, `flattenAgentRouterDeepSeekToolHistory`, `proxy.ts:493-540`).
- Backpressure: `writeChunk` honors `write()` return and `drain`/`close` (`proxy.ts:893-911`); upstream reader is not pulled while downstream is blocked (TCP backpressure propagates).
- Auth-header hygiene: outbound headers rebuilt fresh; client auth headers never forwarded (`buildUpstreamHeaders`, `proxy.ts:131-170`); upstream response headers allowlisted (`proxy.ts:190-205`).
- Bounded diagnostics: `x-router-attempt-summary` capped (16 entries/4096 chars, base64url, `proxy.ts:210-226`) and locally decodable (`attempt-summary.ts:37-81`).
- Config persistence is atomic with optimistic revisions (`config.ts:248-253,92-94,165-177`), serialized mutation queue (`config.ts:154-163`).

---

## 3. Security findings

### 3.1 Dashboard tier has no functional CSP (Medium)

- Evidence: `serveStatic` CSP selection (`server.ts:1146-1157`) — paths `/`, `/dashboard`, `/app.js`, `/styles.css` take the final `else` branch yielding only `"frame-ancestors 'none'"`. `public/index.html:8-45` contains an inline theme bootstrap script (so naive `script-src 'self'` would break it). Dashboard holds the admin token in `localStorage` (`public/app.js:44,3404`), rendered via `textContent` but with `renderMarkdown` writing `innerHTML` after escaping (`app.js:590-634`) and chat bubbles via `innerHTML` (`app.js:2262,2370`).
- Impact: a single DOM XSS in the dashboard app (which renders model/provider data) would have no script-src defense and could read the stored token. Threat model: loopback + origin gates make this defense-in-depth rather than a standalone vulnerability.
- Smallest fix: externalize the inline bootstrap into an allowlisted static file (add to `staticFiles`), then give dashboard paths the same tier as the sandbox: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Static-frontend tests must be updated in the same change.

### 3.2 Regex SVG gate is bypassable as a sanitizer; render context is the real defense (Medium/Low)

- Evidence: `validImage` SVG check (`admin-images.ts:49-55`) rejects `<script|foreignObject|iframe|object|embed`, `on[event]`, `<!DOCTYPE|<!ENTITY`, but misses `<?xml-stylesheet …?>`, `<style>@import`, `<a xlink:href>`, `<image href>`, `<use>`, `<feImage>` — all of which can trigger network fetches when the SVG is opened as a document. Server returns `data:` URLs (`admin-images.ts:147`); Fieldbook renders them via `<img>` (passive context) or sanitized `sandbox` iframes with network-blocking CSP (`public/sandbox.js:284-310`).
- Impact: residual risk is user-initiated: downloading the `.svg` (`sandbox.js:449`) or opening the data URL top-level. Provider output is untrusted (image models can be prompted to emit hostile SVG).
- Smallest fix: tighten the regex negatives (reject `xml-stylesheet`, `style`, `a`/`image`/`use`/`feImage` with external refs, `javascript:`/`data:` hrefs, `@import`) and keep the current render-boundary rule as the enforcement point; never serve generated SVG as a top-level document from an allowlisted path. (Full DOM parsing would require a dependency — excluded.)

### 3.3 Missing `redirect` policy on several outbound fetches (Low)

- Evidence: `redirect: "manual"` on proxy upstream calls (`proxy.ts:1187`), `redirect: "error"` on catalog (`catalog.ts:492`) and credits (`credits.ts:51`) — but image/audio fetches omit it: `admin-images.ts:131`, `admin-audio.ts:307,400,495,514` (verified by reading). OWASP SSRF guidance: disable redirect following.
- Impact: a compromised/misconfigured provider base URL answering 307 could replay an image/audio POST elsewhere (auth header is stripped cross-origin by the fetch spec, body is not relevantly sensitive; impact is low but the fix is one line each).
- Smallest fix: add `redirect: "error"` at those five sites. (The `server.ts:601` self-call to loopback is fine.) [fix value corrected to `redirect: "manual"` — see Audit pass 3 (2026-09-04)]

### 3.4 Generic-provider SSRF posture: hostname string checks only (Low; Medium when `ALLOW_PRIVATE=true`)

- Evidence: `genericBaseUrl()` (`server.ts:68-76`) validates protocol, credentials-in-URL, path shape — but never inspects `parsed.hostname` against private ranges; DNS rebinding / dword-octal-IP / trailing-dot forms are not considered. OWASP SSRF cheat sheet: allowlists preferred; deny-list hostnames alone are bypass-prone.
- Impact: default config is HTTPS-anywhere (SSRF to arbitrary public hosts is inherent to "generic OpenAI provider" — operator-configured, trusted). With `GENERIC_OPENAI_ALLOW_PRIVATE=true` (documented for vLLM/LM Studio), a rebinding domain could reach loopback services.
- Smallest fix: when the private flag is on, `dns.lookup` the hostname at startup and reject non-private-resolving names (or document the trust assumption more strongly). Zero dependencies needed (`node:dns`, `node:net`).

### 3.5 Origin-gate gaps on unauthenticated GETs during the no-key fallback (Low)

- Evidence: `GET /v1/models` (`server.ts:1182-1195`) and `GET /metrics` (`server.ts:1217-1227`) check only `inferenceAuthorized`/`dashboardAuthorized` (loopback fallback via `isLoopback`, `server.ts:126-128`), with no `browserOriginAllowed` check — unlike POST inference (`server.ts:1203-1205`) and `/admin/api/*` (`server.ts:1229-1233`). DNS-rebinding pages can read them when no token/key is configured.
- Impact: model list and aggregate metrics (non-secret by design) become readable by a rebinding malicious page; POSTs are already protected by the Origin gate.
- Smallest fix: when the no-credential loopback fallback is active, apply `browserOriginAllowed` (or require a loopback `Host`) to these two GETs as well.

### 3.6 `/healthz` echoes catalog error strings unauthenticated (Low/Medium)

- Evidence: `server.ts:1177-1180` returns `catalog.status()`; error text is raw `Error.message` from upstream fetches (`catalog.ts:531`) exposed via `status().lastError` (`catalog.ts:404-415`), can embed provider error bodies/URLs/account hints. Dockerfile runs `HOST=0.0.0.0` inside the container (published loopback-only by default in compose).
- Smallest fix: return `{status:"ok"}` (and keep detailed catalog status on `/admin/api/status` where it already lives, plus the readiness projection at `/admin/api/readiness`); or strip error strings to a bounded status class in `healthz`.

### 3.7 Managed client-key hashing is sound (Info, no action)

- Evidence: `rtk_` + 32 random bytes (256-bit, `client-api-keys.ts:63`); SHA-256 digests persisted (`client-api-keys.ts:125-127`) with length-guarded `timingSafeEqual` (`client-api-keys.ts:50-57`); shown once; cap 64; immediate revoke.
- Verdict: OWASP slow-hash/salt guidance targets low-entropy passwords; 256-bit random keys make unsalted fast hashing cryptographically adequate here. Optional defense-in-depth: HMAC with an env pepper; otherwise document the entropy rationale (security-model.md already gestures at this).

### 3.8 Secrets at rest and browser storage are proportionate (Info)

- Evidence: credentials persist plaintext under 0700 dir/0600 file with atomic writes (`provider-credentials.ts:136-149`); tombstones suppress env fallback (`provider-credentials.ts:95-103`); tests lock modes (provider-credentials.test.ts). Dashboard token in localStorage is the single client-side secret; header-only transport; no CORS headers, and cross-site simple requests fail the Origin gate (no-token mode) or the token check (token mode) (`server.ts:145-149,151-162`).
- Verdict: appropriate for the documented threat model (trusted single-user host). Document: never back up `DATA_DIR/secrets` unencrypted.

### 3.9 Static serving headers are otherwise strong (Info)

- Evidence: `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `permissions-policy`, per-path content types (`server.ts:1143-1158`). The generic `json()` helper lacks nosniff (`server.ts:168-176`) — cosmetic; align for consistency.

---

## 4. Performance & efficiency

Scale context that governs severity: single user, a few concurrent agent streams, well under ~10 req/s; the hot-path items below matter only where noted.

### 4.1 Catalog deep-clones on every inference request (Medium when the catalog is large)

- Evidence: every proxy request clones the full model list via `getModels(protocol)` (`catalog.ts:378-383` structuredClone) at `proxy.ts:1063`, filters endpoint kind, and runs `router.candidates` over the clone (`router.ts:51-144`); per-success pricing lookups call `getModels()` twice more (`proxy.ts:1392,1466`) and `resolve()` clones a model per attempt (`proxy.ts:1147`; `catalog.ts:389-392`); `server.ts:1056` clones config (needed — the sandbox path mutates it, `proxy.ts:1057-1060`).
- Measurement (research agent, Node 22): structuredClone of a ~3,000-entry catalog ≈ 10 ms + ~3 MB garbage; of the 5-model fallback set ≈ 5 µs. Real catalogs: OpenRouter can contribute 1–3k models. So per-request pre-TTFT overhead can be ~20–40 ms + ~10 MB churn when a live OpenRouter catalog is present. [updated — see Audit pass 2 (2026-09-04): today's live OpenRouter catalog is ~426 models (~0.63 KB/model normalized), so a clone is ~1.5 ms and per-request overhead ~5 ms; the 20–40 ms figure applies only to multi-thousand-model catalogs. One more per-request clone exists at `proxy.ts:1536`. [cite corrected: :1536 is the good `resolve()` pattern; the waste is :1392/:1466 — see Audit pass 3 (2026-09-04)]]
- Smallest fix: stop cloning on reads — `rebuild()` already replaces `this.models` wholesale (`catalog.ts:537-539`); return the frozen internal array (or precomputed per-protocol filtered views refreshed in `rebuild()`), and confirm no caller mutates returned models (none do today). Keep `config.get()`'s clone.

### 4.2 SSE path double-parse and redundant copies (Negligible/Low)

- Evidence: the same SSE data line is `JSON.parse`d by `StreamInspector` (`proxy.ts:1618`) and again by `StreamSanitizer` (`proxy.ts:1623`); measured ~2 µs/event — negligible. `readResponseBuffer` copies each undici chunk via `Buffer.from` before one `Buffer.concat` (`proxy.ts:343-345`) — one redundant full-body copy (up to 64 MiB) on the non-stream path; drop the per-chunk copy. Non-stream success path re-stringifies the whole payload a second time after `model` substitution (`proxy.ts:1463-1464` plus `parseSuccessfulJson`'s own serialization at `proxy.ts:324`) — serialize once.
- A 64 MiB non-stream JSON parse blocks the event loop ~0.5 s (measured 125 MB/s parse) while other streams stall — accept the caps (no dependency-free streaming parser) but avoid the redundant copies/stringify.

### 4.3 metrics.json full-file rewrite on a 1 s debounce (Negligible at RouteTok rates)

- Evidence: `record()` → 1 s unref'd debounce → atomic full-state write (`metrics.ts:293-357,537-557`), serialized queue; worst case at caps (5,000 samples + 100 recent + ~2k model aggregates) ≈ 2.85 MB, ~16–20 ms stringify per write ≤ 1 Hz — acceptable. No fsync: fine for telemetry (crash loses ≤1 s). Do not add fsync.
- Smallest fix (optional): serialize compact to halve size; or leave as-is.

### 4.4 Connection handling (Info/cosmetic)

- Evidence: Node defaults in force (`createServer` without options, `server.ts:1166`): `keepAliveTimeout` 5 s, `headersTimeout` 60 s, `requestTimeout` 300 s (request-receive only), `timeout` 0 — none of them interfere with 10-minute SSE responses (verified against Node docs; the research agent also verified `requestTimeout` semantics don't apply to response phases). Undici global fetch pool: per-origin sockets reused while warm; 4 s idle keep-alive means tool-loop gaps mostly pay a fresh TLS handshake — negligible locally, and tuning requires the `undici` package (excluded).
- Optional: `createServer({ keepAliveTimeout: 60_000, headersTimeout: 120_000 })` keeps agent keep-alive sockets warm between multi-minute tool turns; cosmetic at this scale.
- Graceful shutdown (`server.ts:1595-1607`) order is correct (`close` then 5 s `closeAllConnections`); note that active SSE streams are hard-cut at 5 s and their metrics records never finalize — consider `closeIdleConnections()` first and record in-flight aborts as 499 cancellations on the drain path (the plumbing exists: `metrics.ts:298,378-385`).

---

## 5. Test & coverage gaps

Coverage is strong overall: all 16 src modules have unit or integration tests; the hardest invariants (pre-output fallback, paid-OR 429 chain, entitlement-403 vs account-policy classification, sandbox caps, secret redaction, tombstones) are exercised by integration tests against throwaway child servers with blanked provider keys (`test/support/process.ts:22-55`).

Real gaps identified:

1. `retry-after` HTTP-date form and 1 s/1 h clamping untested — `retryAfterMs` handles seconds and dates (`proxy.ts:352-359`); every fixture sends `retry-after: "1"` (paid-fallback.test.ts:134).
2. `requestTimeoutMs` overall-deadline abort untested (only `firstEventTimeoutMs` is exercised) — directly relevant to the Section 2.2 fix.
3. Metrics save debounce/flush untested (`metrics.ts:529-557`); `metrics.test.ts` only tests load normalization.
4. Config-proposal expiry (`410`, `server.ts:1518-1527`) untested; only validate/apply-confirmed flows are covered.
5. Entitlement-403 re-probe/half-open retention across multiple requests untested (classification-to-health is covered).
6. SSE byte-fragmentation: no tests push partial events across chunk boundaries, CRLF splits, or blank-line edge cases to `StreamSanitizer`/`StreamInspector` — the exact class of bug that would corrupt streams in the wild. [subagent-read; router.test.ts covers whole events] [updated — see Audit pass 2 (2026-09-04): directly verified; additionally `StreamSanitizer`/`streamEventBlocks` are not exported from `proxy.ts`, so only `StreamInspector` is testable today]
7. `admin-images` deeper paths (unsupported aspect/quality/format values; model-not-enabled) untested; audio `retry-after` on 429 and PCM byte validation untested.
8. Legacy `/messages` alias untested.
9. No static-frontend test locks the CSP tier strings for dashboard vs sandbox (would have caught Section 3.1); existing tests lock module URLs/script tags — which is precisely why the current index.html+allowlist contract drift in prod is detectible but nothing enforces file-presence.
10. No test asserts `getModels()` results are treated as immutable (would permit the Section 4.1 change safely).

---

## 6. Missing features / roadmap ideas

Each: priority (P1/P2/P3), effort (S/M/L), fit. None require runtime dependencies.

### P1
- **Circuit half-open single-probe + immediate reopen on probe failure.** Effort S. Fixes a real failure mode (2.1). Server only, fits perfectly. Add the missing half-open tests (Section 5.5).
- **Detach the overall deadline after stream commit.** Effort M. Server + docs (`docs/api.md` timeouts) + test. Enables >10-minute generations.

### P2
- **`/readyz` readiness split + minimal `/healthz`.** Effort S. `healthz` stays liveness; readiness = 503 only when the catalog holds no viable model at all. Ops-correct and matches Kubernetes/Docker probe conventions.
- **Static-asset boot verification + smoke script** (2.8). Effort S. Prevents the exact prod drift that is currently live.
- **Per-provider/global in-flight cap with 429/503 shed** (2.5). Effort M. Mirrors the existing sandbox concurrency pattern; add config bounds.
- **Spend guardrails (per-day/per-month paid-route cap)** — borrow LiteLLM budgets. Effort M. Fits local-first: the dashboard already tracks cost (`costUsd`), and a soft cap that returns `429` when the paid-OR chain would exceed a configurable daily spend protects the operator from runaway agent loops. Must respect the "no bodies in metrics" rule (only totals needed).
- **Per-model error *class* persistence instead of raw error strings** in `byModel.errors` (Section 8 of observability research). Effort S–M. Keeps diagnostics while trimming on-disk raw upstream text (which can embed URLs/account hints).
- **Randomized tie-break/jitter in candidate scoring** (2.4). Effort S.

### P3
- **Context-window precheck warning (or fallback-to-larger-context) using catalog `contextTokens` + a chars/4 token estimate** — LiteLLM `enable_pre_call_checks` analogue. Effort M. The Fieldbook already estimates context client-side (`sandbox.js` budget gauge); a server-side optional precheck would need the same approximation — fit is decent, value modest.
- **Content-policy / context-window typed fallbacks** (LiteLLM `content_policy_fallbacks`, `context_window_fallbacks`). Effort M. RouteTok already special-cases AgentRouter content-filter 400s as terminal (`proxy.ts:1260-1278`) — extending to a policy fallback list is a natural follow-up but adds routing semantics; verify need first.
- **Attempt replay from the dashboard** (build on `attempt-inspector.js` curl replay + `/admin/api/requests/:id/content`). Effort M. Nice ops loop for a local tool; needs care to keep replay bodies out of retention.
- **Request-content retention opt-out env** (`ROUTETOK_RETAIN_REQUEST_CONTENT=0`, see Section 5.8 research). Effort S. Minimal-telemetry courtesy toggle; keep default-on with current bounds.
- **`process_start_time_seconds` + missing `# TYPE`/`# HELP` on model families; request-duration `_sum`/`_count`; TTFT count rename** (Section 7.2). Effort S each. All text-format-only.

### Deliberately not fitting (documented, not built)
- Semantic caching / request coalescing: multi-tenant value; prompt reuse in a single-user router is the client's job; caching risks stale-model semantics.
- Multi-tenant keys/budgets/SSO/audit: out of scope for a single-operator loopback tool; would violate "no bodies" and add storage.
- Load balancing the same model across duplicate provider entries: routing here is model-first per provider credential; duplicates add config surface with little local value.
- Token-counting libraries (tiktoken-style): banned by the zero-dependency rule; char/4 estimates already used in the Fieldbook.
- Streaming request passthrough (no body buffering): incompatible with model substitution + pre-output fallback replay; buffering at 16 MiB is the correct trade (and Anthropic's own limit is 32 MB — optionally raise `MAX_REQUEST_BYTES` to match, `proxy.ts:18`).

---

## 7. Best-practice deltas observed vs researched

| Area | RouteTok today | Best practice (source) | Delta |
|---|---|---|---|
| Circuit half-open | floodgate; reopen after 3 consecutive | single/bounded probe; reopen on probe failure (Hystrix/Resilience4j/Envoy) | Fix 2.1 |
| Retry window | pre-output only, stream-commit terminal | LLM retries only pre-output; SSE errors post-200 not SDK-retried (Anthropic errors doc) | Conformant |
| Downstream backpressure | drain-aware write loop | drain/HWM discipline (Node backpressuring guide) | Conformant |
| Upstream header hygiene | allowlist + credential substitution | never forward client auth (universal) | Conformant |
| Candidate ordering | deterministic score, lifetime counters | randomized/P2C, windowed metrics (Envoy) | Deltas in 2.4 |
| Global shedding | only sandbox capped | per-cluster active-request breakers + retry budgets (Envoy) | Missing (2.5) |
| SSE parsing | full parse→mutate→serialize per event | fine at this scale; avoid string-splicing (correctness) | Conformant; micro-opt 4.2 |
| Request deadlines | one 600 s ceiling includes committed streams | timeouts apply pre-commit; long generations stream (Anthropic) | Fix 2.2 |
| Liveness/readiness | single always-200 healthz echoing catalog errors | split probes; healthz independent of upstream (K8s) | Fix (P2) |
| Metrics | dual-prefix families, missing TYPE lines, nonstandard `_samples_total` count, no duration family | one canonical name, HELP/TYPE before samples, `_sum`/`_count` conventions (Prometheus docs) | Fixes in Section 4/6 |
| Shutdown | 5 s closeAllConnections; single-shot signal handlers | drain with notice, hard-exit timer, second-signal force (Node docs) | Minor (Section 4.4) |
| Static assets | request-time 500 on missing allowlisted file; `?v=` cache busting | fail-fast boot checks; content-addressed assets; smoke tests | Fix 2.8 |
| Docker | non-root, ro rootfs, cap-drop, tmpfs, init | OWASP Docker hardening — largely matched | Add: digest-pinned base image; mem/pids limits on the main service (Section 5.9 research) |
| CSP | dashboard tier is `frame-ancestors` only | strict `default-src 'self'` etc. once inline script externalized (OWASP CSP) | Fix 3.1 |
| Sandbox/artifact rendering | data URLs + sandboxed iframes with network-blocked srcdoc, textContent-only DOM | sandboxed frames + CSP + no same-origin (OWASP HTML5) | Conformant |

---

## 8. Documentation / drift items

### 8.1 Prod ↔ git drift (verified by direct diff; matches and refines AGENTS.md)

- `src/` is byte-identical between prod and git (`diff -rq` clean).
- `docs/`: prod lags git by 3 commits on `api.md`, `architecture.md`, `dashboard.md`, `fieldbook.md`, `providers.md`, `security-model.md`; `docs/onboarding.md` exists only in git.
- `public/` shared files are byte-identical except `index.html` (git adds the three script tags for `attempt-inspector.js`, `api-setup.js`, `onboarding.js`). Four git-only files are missing in prod: `public/api-setup.js`, `public/attempt-inspector.js`, `public/onboarding.js`, `public/fieldbook/backup.js` — all four are in the prod `staticFiles` allowlist (prod `src` == git `src`, `server.ts:1100-1123`), so **prod returns 500 for these URLs** (file in allowlist, missing from disk).
- Prod-only leftovers (not in git, not in allowlist): `public/dashboards/` (build output of the local-only, never-merged `feature/alternate-dashboards` branch, commit `f3411d7`), top-level `public/studio-chat.js` and `public/image-approvals.js` (byte-identical duplicates of their `fieldbook/` counterparts).
- Root: prod lacks `Dockerfile`, `compose.yml`, `.env.example`'s compose-only section, and the Unreleased CHANGELOG/README updates. `AGENTS.md` exists only in prod (not tracked in git).
- Recommended hygiene: delete or quarantine the prod leftovers; sync `index.html` + the four modules together (never separately — version strings `?v=` differ between the module set and app.js); add boot-time asset verification (2.8).

### 8.2 Docs that describe dashboard behaviors the current app does not implement

- Evidence: `docs/dashboard.md` §Attempt Inspector and §API Setup, `docs/onboarding.md`, and `docs/api.md` say "the dashboard loads `window.AttemptInspector`/`window.ApiSetup`/`window.Onboarding`" [superseded — see Audit pass 2 (2026-09-04): `docs/api.md` contains no such mention; only `docs/dashboard.md:59,63` and `docs/onboarding.md:3` do]. `index.html:643-646` loads the three scripts [updated — pass 2: the tags are at 643-645; 646 is `app.js`], and each exposes a `mount()`, but **nothing in `public/app.js` (4487 lines) references `AttemptInspector`, `ApiSetup`, or `Onboarding`** (grep-verified; the same is true across the rest of `public/`). The API-access drawer, client-key manager, and proposal flow are implemented natively inside `app.js` (e.g. client keys at `app.js:4055-4092`), so the three modules are dead-loaded (≈75 KB) [superseded — pass 2: they total 40,792 bytes, ≈40 KB; a fourth dead-loaded module, `fieldbook/backup.js` (~9 KB), was also found] and their documented workflows (paste-to-decode attempt inspector, 401 test-request remediation, 5-step onboarding wizard) are not reachable in the current dashboard.
- Impact: docs/frontend contract drift; the modules can rot unnoticed (their endpoints/redaction behaviors are only locked by static tests that never run them in a page); prod's missing-file 500s are the same files.
- Options: (a) mount them where the docs claim (wire into app.js UI), or (b) update docs + remove the dead script tags and files (and prod drift disappears with them). Either way, docs and `test/static/frontend/*` must move together. Marked as the most consequential doc-vs-code drift found.

### 8.3 Smaller doc items

- `docs/api.md` (model metadata §, and the sandbox section) vs CHANGELOG: the Unreleased entry says sandbox output is unlimited by default, but `docs/api.md:90` still states "The default remains 4 MiB" — `fieldbook.md:28` and `configuration` docs were updated; `api.md` was not. [prod's api.md lag and git's own api.md both checked — git `api.md:90` still says 4 MiB default while `src/server.ts` + fieldbook docs say unlimited]
- `docs/security-model.md` says dashboard CSP is strict for dashboard/sandbox/fieldbook "distinct policies" [superseded — see Audit pass 2 (2026-09-04): attribution error; `docs/security-model.md` contains zero CSP mentions. The "distinct policies" language lives in the prod-only `AGENTS.md`. The server-side fact stands:] — the dashboard tier is currently `frame-ancestors` only (Section 3.1); the docs describe intent, not reality.
- `AGENTS.md` (prod-only file) accurately describes the drift and the allowlist mechanism; it is not version-controlled — consider tracking it (or a `CONTRIBUTING` pointer) in git so the ops knowledge travels with the repo.
- `.env.example` ↔ code coverage is clean (39 env reads, all documented; the only undocumented vars are `BENCHMARK_BASE_URL`/`BENCHMARK_OUTPUT_DIR` in `scripts/benchmark-free-models.mjs:4-5` — script-only).
- Attempt-Inspector latents: `buildReplayCurl` redacts secret *headers* for display but stores the raw candidate JSON (including any headers present) in `option.dataset.payload` (`attempt-inspector.js:410-416`) and emits the body unredacted (`attempt-inspector.js:149`). Today's `/admin/api/live` and `/admin/api/history` shapes contain no headers/bodies, so nothing sensitive flows — but if a future payload adds `headers`/`body`, the dataset and clipboard paths leak. Fix cheaply by redacting at storage time, not display time.

---

## Appendix A — Severity-ranked quick list

| # | Finding | Location | Severity |
|---|---|---|---|
| 1 | Half-open circuit stampede; no single-probe semantics | router.ts:129-187 | Medium |
| 2 | Overall 600 s deadline truncates committed streams | proxy.ts:1115-1117,1162; config.ts:10,67 | Medium |
| 3 | Dashboard CSP effectively absent | server.ts:1146-1153 | Medium |
| 4 | No global/per-provider in-flight shed on client path | server.ts:735 vs proxy.ts | Medium |
| 5 | Deterministic re-sort herding + lifetime-counter scoring | router.ts:138-142,229-237 | Medium |
| 6 | SSE pending buffers unbounded per event | proxy.ts:571-580,603-615 | Medium (rare trigger) |
| 7 | Allowlist 500s on missing files; no boot check / smoke test | server.ts:1100-1163 | Medium (deployment) |
| 8 | `/healthz` echoes raw provider error strings unauthenticated | server.ts:1177-1180; catalog.ts:404-415 | Low/Medium |
| 9 | Per-request full-catalog structuredClone ×3-4 | catalog.ts:378-392; proxy.ts:1063,1392,1466 | Medium (large catalogs only) |
| 10 | Outbound fetches missing `redirect:"error"` (5 sites) | admin-images.ts:131; admin-audio.ts:307,400,495,514 | Low |
| 11 | Dashboard modules loaded but never mounted; docs describe them | index.html:643-646; app.js (no refs) | Medium (docs/code drift) |
| 12 | 429 stops non-OR cascades with healthy siblings | proxy.ts:1218-1241 | Low (policy) |
| 13 | SVG regex gate misses xml-stylesheet/style/`<use>`/`<image>` refs | admin-images.ts:49-55 | Low (render context mitigates) |
| 14 | metrics: dual prefixes; missing TYPE; TTFT `_count` naming; no duration family | metrics.ts:447-527 | Low |
| 15 | Request-body retention default-on, no opt-out env | proxy.ts:975-993 | Low (design call) |
| 16 | Raw upstream error strings persisted per model | metrics.ts:326-333 | Low |
| 17 | Room turn consumed on failure without refund | sandbox.js:772-778 | Low (design) |
| 18 | No backoff/jitter between same-provider fallback attempts | proxy.ts:1146-1486 | Low |
| 19 | Graceful shutdown cuts streams at 5 s without metric finalize | server.ts:1595-1607 | Low (ops) |
| 20 | Base image not digest-pinned; no mem/pids limits on main service | Dockerfile:3,13; compose.yml | Low (supply chain) |

## Appendix B — Research sources (primary anchors)

- Anthropic streaming reference: https://platform.claude.com/docs/en/build-with-claude/streaming (events, deltas incl. `signature_delta`, `message_delta` usage, ping/error events)
- Anthropic errors/rate limits: https://platform.claude.com/docs/en/api/errors , /api/rate-limits
- OpenAI Responses/Chat streaming conventions (reasoning fields, usage-chunk semantics) — verified via RouteTok implementation against SDK-observed streams in tests (`router.test.ts:287-371`)
- Node http server options: https://nodejs.org/api/http.html (serverrequesttimeout, keepalivetimeout, closeallconnections)
- Undici (built-in fetch) client defaults: https://github.com/nodejs/undici (Agent.md, Client.md)
- Backpressure: https://nodejs.org/en/learn/modules/backpressuring-in-streams
- Circuit breakers: Hystrix wiki; https://resilience4j.readme.io/docs/circuitbreaker ; Envoy outlier/CB docs
- Retry/jitter: AWS exponential-backoff-and-jitter post; MDN Retry-After
- Envoy LB herding/P2C: Envoy load_balancers docs
- OWASP: SSRF Prevention, CSRF Prevention, HTML5 Security, CSP, Password Storage, Docker Security, Secrets Management cheat sheets
- Prometheus: naming, instrumentation, exposition formats, histogram docs
- LiteLLM fallbacks/cooldowns/budgets: https://docs.litellm.ai/docs/proxy/reliability
- Kubernetes probes: pod-lifecycle docs
- DOMPurify attack-classes wiki (SVG sanitizer bypass taxonomy)

## Appendix C — Audit caveats

- Items marked `[subagent-read]` were reported by delegated deep-read agents with line citations; the load-bearing ones were spot-verified by direct grep/sed. Line numbers refer to git HEAD `cddfbdf`; `public/` files contain very long lines, so a few cited lines pack many statements.
- Severities assume the documented single-user loopback threat model; items are marked higher where they matter only under non-default posture (`HOST` exposed, large live catalogs, `ALLOW_PRIVATE=true`).
- No changes were made to any file. This report is intentionally advisory; smallest-fix proposals are suggestions, not patches.

---

## Audit pass 2 (2026-09-04)

Second-generation audit. Same HEAD (`cddfbdf` — no code moved since pass 1), same constraints. Method: independent full re-read of all of `src/` (every load-bearing baseline citation verified personally against the code), three parallel deep-read agents (frontend, test tree, docs/deploy/CI + independent prod diff), six parallel best-practice research workstreams (2025-2026 upstream API drift; IndexedDB/agent-loop engineering; dependency-free fuzz/chaos testing; error-hygiene/spend-guardrails; Node HTTP hardening; catalog-at-scale), and three parallel cross-reference verifiers covering (baseline + new) findings. The load-bearing new finding (P2-1) was verified against official OpenAI documentation personally. Research URLs are listed in Appendix B2 below.

### Delta table — disposition of every pass-1 finding

| Pass-1 finding | Verdict | Notes (current evidence) |
|---|---|---|
| 2.1 Half-open stampede | CONFIRMED | `router.ts:129-136,179-187` unchanged. Still no test coverage (Section 5.5 confirmed). |
| 2.2 Overall deadline kills committed streams | CONFIRMED, sharpened | `proxy.ts:1115-1117,1162,1515`; additionally `config.ts:67` clamps `requestTimeoutMs` to max 600,000, so operators cannot raise the ceiling. Anthropic and OpenAI 2026 docs both normalize >10-minute streams (Anthropic errors doc "Long requests"; OpenAI background mode). Cross-ref fix note: clear the *timer* post-commit, do not sever the controller — client-disconnect still needs it (`proxy.ts:1119-1128`, `pipeStream` cancel at 1636). Residual: downstream read-stall then bounded only by socket close — document in `docs/api.md`. |
| 2.3 Unbounded SSE pending buffers | CONFIRMED | `proxy.ts:571-580,603-615,695-700` unchanged. |
| 2.4 Deterministic herding / lifetime counters | CONFIRMED | `router.ts:138-142,229-237`. |
| 2.5 No client-path in-flight cap | CONFIRMED | `server.ts:735-739` sandbox-only. Extended by Node-hardening research: also no inter-chunk body-read timeout (`proxy.ts:381-391`, `server.ts:178-188`); Node defaults runtime-verified on Node 22.19.0 (keepAlive 5s, headers 60s, requestTimeout 300s request-phase only). |
| 2.6 Non-429 rate limits stop cascades | CONFIRMED | `proxy.ts:1218-1241`; policy decision still open. |
| 2.7 Fallback loop details | CONFIRMED, one line corrected | Room no-refund verified at `sandbox.js:772-775`; Studio failure refund is at `sandbox.js:1042` (1036 is the user-pause refund). `recordSuccess` clears `rateLimitedUntil` at `router.ts:152` — verified. |
| 2.8 Allowlist 500s on missing files | CONFIRMED | `server.ts:1140-1163`; still live in prod. Fix placement pinned by cross-ref: insert boot check immediately after the `staticFiles` literal (after `server.ts:1123`), covering 19 unique files + the two manifest fallbacks (1136-1137). |
| 2.9 Verified-correct invariants | CONFIRMED | All re-verified personally (pre-output buffer `proxy.ts:851-891`; commit semantics; `writeChunk` backpressure 893-911; header hygiene 131-170; attempt-summary caps 210-226; config atomicity `config.ts:248-253`). |
| 3.1 Dashboard CSP absent | CONFIRMED | `server.ts:1153`. Fix feasibility verified: exactly one inline script (`index.html:8-46`), zero inline handlers, zero eval-family constructs in dashboard scripts; `styles.css:139` `data:` image is covered by the proposed policy. |
| 3.2 SVG regex gate | CONFIRMED | `admin-images.ts:49-55`; render context remains the real defense (`sandbox.js:284-310`); raw-SVG download paths at `sandbox.js:449` and `861-864`. |
| 3.3 Missing `redirect` on 5 fetches | CONFIRMED | `admin-images.ts:131`; `admin-audio.ts:307,400,495,514` — re-verified; catalog (`catalog.ts:492`) and credits (`credits.ts:51`) correctly use `redirect:"error"`. |
| 3.4 Generic-provider SSRF posture | CONFIRMED | `server.ts:68-76` unchanged. |
| 3.5 Origin-gate gaps on GETs | CONFIRMED | `server.ts:1182-1195,1217-1227` unchanged; additionally the Origin gate has zero test coverage (Section 5 addition below). |
| 3.6 `/healthz` echoes catalog errors | CONFIRMED | `server.ts:1177-1180`; `catalog.ts:404-415,531`. K8s-probe research: reporting dependency status without failing on it is correct; only the *content* exposure needs trimming. |
| 3.7 / 3.8 / 3.9 (Info items) | CONFIRMED | `client-api-keys.ts:50-57,63,125-127`; `provider-credentials.ts:95-103,136-149`; `server.ts:168-176`. |
| 4.1 Catalog deep-clones | CONFIRMED, recalibrated | Live OpenRouter catalog measured at ~426 models (~706 KB raw, ~0.63 KB/model normalized): one clone ≈ 1.5 ms; per-request cost today ≈ 5 ms, not 20–40 ms. Severity: Low today, Medium at 2k+ models. Additional per-request clone found at `proxy.ts:1536` (`resolve(selectedModel)` in the metrics record). Cross-ref confirms no caller mutates returned models → frozen views are safe. |
| 4.2 SSE double-parse / redundant copies | CONFIRMED | `proxy.ts:343-345,1463-1464,324`. |
| 4.3 metrics.json rewrite | CONFIRMED | `metrics.ts:293-357,537-557`. |
| 4.4 Connection handling / shutdown | CONFIRMED, extended | Node 22.19.0 defaults runtime-verified. New details: `keepAliveTimeoutBuffer` (1s, ≥22.19.0) makes the effective keep-alive 6s; Node 24/26 docs list a different `createServer` option default (65s) — re-check on engine bump. Shutdown: `closeIdleConnections()` never called and `process.once` (`server.ts:1609-1610`) gives no second-signal force-exit. |
| 5.x All 10 test gaps | CONFIRMED (10/10) | Directly re-verified against the test tree. Cleared both `[subagent-read]` flags (item 6 and 2.7). Item 9 nuance: integration tests DO lock the sandbox/gallery CSP tiers (`proxy.test.ts:356,370,377`); only the dashboard tier is unlocked. |
| 6.x Roadmap | CONFIRMED | Extended below. Spend-guardrail design sharpened by research: enforce on reported cost first, with a `reported_only`/`reported_plus_estimated` mode so a bad estimate can't hard-block. |
| 7. Best-practice deltas table | CONFIRMED | No row refuted; two rows extended (deadlines, metrics). |
| 8.1 Prod↔git drift | CONFIRMED, worse than reported | See U-3 below. |
| 8.2 Dead-loaded dashboard modules | CONFIRMED with corrections | `docs/api.md` attribution was wrong (api.md never mentions the modules; only `docs/dashboard.md:59,63`, `docs/onboarding.md:3`); modules total ~40 KB, not ~75 KB; script tags are `index.html:643-645`. A fourth dead-loaded module found: `fieldbook/backup.js` (N-F4). |
| 8.3 Smaller doc items | CONFIRMED except one attribution | `api.md:90` stale 4 MiB — still present. The CSP-doc claim was mis-attributed to `security-model.md` (zero CSP mentions there; the language is in prod-only `AGENTS.md`) — server-side fact stands. Env coverage, AGENTS.md untracked, attempt-inspector latents: all confirmed. |
| Appendix A items 1-20 | All stand | #11 corrected per 8.2 (size/lines); #16 extended (new upstream-controlled key sources, N-S1); #15 reinforced (default-on body retention deviates from LiteLLM/OTel opt-in norms — add the opt-out toggle). |

### NEW findings (pass 2)

#### Correctness & reliability

**P2-1 (High) — OpenAI Responses-API bare `error` events are silently dropped on committed streams.** Evidence: `proxy.ts:642-646` — for `/v1/responses`, `allowed = type.startsWith("response.") || Boolean(value.error)`; OpenAI's documented streaming error frame is `{type:"error", code, message, param, sequence_number}` (official `ResponseErrorEvent`, verified against the OpenAI API reference this pass) — no `error` key, type doesn't start with `response.` → `return []`. The `StreamInspector` does notice (`proxy.ts:736` sets `upstreamError`), so `pipeStream` cancels the reader and ends the response (`proxy.ts:1624-1631`) with **no error frame written** (`writeStreamError` only runs on the exception path, 1638). Impact: on an advertised endpoint, a client sees a cleanly truncated stream instead of the terminal error — active client-visible data loss; the attempt is then recorded `transient_error` and the model penalized. Smallest fix: add `type === "error"` to the allow rule and emit the `event: error\n` line alongside `data:` (the existing prefix logic at `proxy.ts:648` already does this when the upstream frame carries an event line; data-only emission is SDK-parseable and matches the router's own error frame at 920-926). Add a unit test next to `router.test.ts:336-353`.

**P2-2 (Medium, latent) — Anthropic sanitizer allowlist inverts Anthropic's versioning guidance.** [downgraded to latent-only — see Audit pass 3 (2026-09-04)] Evidence: `proxy.ts:652-666` forwards only 8 hardcoded event types, silently dropping anything else. Anthropic's streaming doc states new event types may be added and clients "should handle unknown event types gracefully" (platform.claude.com/docs/en/build-with-claude/streaming). Today nothing documented is dropped (2025-2026 additions — `server_tool_use`, `web_search_tool_result`, citations, the server-side-fallback `fallback` block — all arrive inside `content_block_*`), but the next top-level event type becomes silent client data loss with no log. Smallest fix: switch the Anthropic branch to a denylist (keep dropping `billing_summary`/`billing` at 634-639, keep the `message_start` model rewrite), forward unknown types verbatim, log each unknown type once.

**P2-3 (Low/Medium) — Inspector's meaningful-output detection misses newer block/delta types.** Evidence: `proxy.ts:739-763` counts `content_block_start` only for `tool_use` or non-empty `text/thinking/data`, and deltas only for `text/partial_json/thinking/signature/data`. `server_tool_use` (block.type ≠ `tool_use`), `web_search_tool_result`/`web_fetch_tool_result`/`code_execution_tool_result` blocks (start+stop, no deltas), and `citations_delta` never count; an opening `input_json_delta` of `""` fails `hasSemanticValue` (671). A pre-commit window of pure server-tool round trips can therefore trigger a spurious fallback — duplicating paid server-tool calls. Nuance (cross-ref): the first non-empty `partial_json` usually rescues `server_tool_use`; `web_search_tool_result`-only windows genuinely never count. Adjacent: `response.output_item.added` counts only `function_call`/`tool_call` items (788-791). Smallest fix: treat a `content_block_start` with any payload key beyond `type` as meaningful, and any delta key beyond `type` with semantic value as meaningful.

**P2-4 (Low/Medium) — Image-generation concurrency gate is TOCTOU-broken.** Evidence: `admin-images.ts:115` checks `this.active`, then `await readJsonBody(request)` at 117, and only sets `this.active = true` at 126; the `finally` at 151 clears it when the *first* of two racing requests finishes while the second is in flight. Two concurrent requests both pass the check → both fan out to the paid OpenRouter `/images` endpoint; the documented "one generation at a time" shed is void under overlap. Smallest fix: synchronous check+set at the top of `generate()` (the `admin-audio.ts:440-444` `acquire()` pattern), released in the outer finally.

**P2-5 (Low/Medium) — `router.reset()` on any single credential change wipes health for all providers.** Evidence: `server.ts:1427` runs on every `PUT/DELETE /admin/api/providers/:id/credentials/*`; `router.ts:205-207` clears the entire map — every model's circuits, `rateLimitedUntil`, `entitlementBlocked`, EWMA across *all* providers. Impact: rotating one key re-admits known-down models elsewhere (compounds 2.1), re-fires still-rate-limited models, zeroes the latency ordering signal. The intentional full reset already exists at `/admin/api/circuits/reset` (`server.ts:1574-1578`). Smallest fix: scoped `resetWhere(predicate)` on `HealthRouter`, called with the changed provider's models.

**P2-6 (Low) — The 1 MiB admin body cap contradicts the sandbox's own transcript bounds.** Evidence: all `/admin/api/*` JSON reads use `readJson` with a hard 1 MiB cap (`server.ts:178-188`), including `POST /admin/api/sandbox` (731); but `sandbox-tools.ts:4-5` allows 40 messages/500,000 chars *per branch* and `sandboxRequest` allows 4 branches (`server.ts:229-231`) — a fully legal payload is ≈2+ MiB and is rejected with 400 before the documented validators run. Even 2 branches at cap exceed 1 MiB. Smallest fix: dedicated ~4 MiB reader for `/admin/api/sandbox`, or lower/document the per-branch caps; align `docs/fieldbook.md`/`docs/api.md` either way.

**P2-7 (Low) — Responses-API model substitution writes a spurious top-level key and misses the nested `response.model`.** Evidence: `proxy.ts:647` sets `value.model = this.model` on the event *envelope* for `/v1/responses`, but Responses events nest the Response object (`response.created`/`response.completed` carry `response.model`) — the nested field keeps the upstream model ID, contradicting `x-router-model`, while the envelope gains a non-spec key. Chat (647) and Anthropic (`message_start.message.model`, 663-665) rewrite the fields clients actually read. Smallest fix: when `value.response` is an object, rewrite `value.response.model`; skip the top-level assignment on the responses wire.

**P2-8 (Low) — Case-sensitive content-type sniffing on hot paths.** Evidence: `proxy.ts:857` (`includes("text/event-stream")`), `proxy.ts:1423` (`includes("text/html")`), `catalog.ts:497` (`includes("json")`). MIME type tokens are case-insensitive (RFC 2045); an intermediary emitting `Text/Event-Stream` turns every stream into a 502. No known upstream does this today. Smallest fix: lowercase before matching at all three sites.

**P2-9 (Low) — `retry-after` can be lost on the final 429/402 when candidates were skipped.** Evidence: `proxy.ts:1223,1284` test `attempts.length < candidates.length` for "more candidates remain"; candidates skipped at 1150 (`continue` without recording, e.g. mid-request catalog rebuild from the `void refreshIfStale` at 1061) leave this true on the last iteration → loop exhausts → fallthrough (1488-1512) sends 429 `fallback_exhausted` *without* the upstream `retry-after` the dedicated branch preserves (1229-1238). Smallest fix: index-based remaining test, or forward the last seen `retry-after` in the fallthrough.

**P2-10 (Low) — `usage.cost: null`/junk is recorded as a *reported* $0.00 and suppresses estimation.** Evidence: `proxy.ts:262` (`usage.cost === undefined ? null : decimalValue(usage.cost)`; `decimalValue(null)`/`decimalValue("junk")` = 0) → `reportedCostUsd: 0` set at 270 → the success paths (1394, 1468) skip `estimateCostUsd` because `reportedCostUsd !== undefined`. A provider emitting `"cost": null` (common for nullable fields) zeroes cost accounting instead of falling back to the price-table estimate. Smallest fix: treat non-number/non-finite `cost` as absent.

**P2-11 (Low) — Streaming `recordSuccess` latency is total generation time, not first-output.** Evidence: `proxy.ts:1414` passes `Date.now() - started` (whole stream) into `latencyEwmaMs` (`router.ts:155-157`), feeding the score penalty (`router.ts:235`) — long generations penalize the model, inconsistently with the non-stream path and with the separately tracked `firstOutputMs`. Capped at 50 points vs the 1,000-point order bias, so impact is small. Smallest fix: pass `firstOutputMs ?? Date.now() - started` for streaming success.

**P2-12 (Low, partially UNCERTAIN) — Overall-deadline expiry during `prepareStream` double-records and misclassifies the attempt.** Evidence: when `controller` fires mid-`prepareStream`, the catch at `proxy.ts:1351-1356` checks only `attemptController.signal.aborted` — the message becomes the abort reason text, mapped to 502 unless it contains "deadline", then `continue`; the next iteration's fetch rejects immediately → 504/`break` (1200-1211). Net: a spurious extra 502 attempt record. UNCERTAIN: whether undici reliably propagates the custom abort reason (`abort(new Error("request deadline exceeded"))`) as the body-read rejection message on all Node 22 minors. Smallest fix: check `controller.signal.aborted` first, mirroring 1435-1441.

**P2-13 (Info/Low) — Retained request bodies have no time-based expiry.** Evidence: `proxy.ts:975-993` evicts only by count (>100) or bytes (>16 MiB); a quiet instance keeps up to 100 request bodies indefinitely. Eviction order and gating verified correct. Smallest fix (optional): TTL eviction on insert.

#### Security & privacy

**P2-S1 (Low/Medium) — Upstream-controlled text reaches persisted metrics error keys via two paths.** Evidence: (i) `prepareStream` throws `` `expected text/event-stream, received ${contentType}` `` (`proxy.ts:858`) — upstream-controlled header — propagated at 1351-1353 (stream) and 1437-1441 (non-stream); (ii) `parseSuccessfulJson`'s `JSON.parse` (`proxy.ts:307`) `SyntaxError` messages embed a snippet of the upstream *body* (`Unexpected token '<', "<!DOCTYPE "…`), also via 1441. Both land as `byModel.errors` keys (`metrics.ts:330-331`), persisted to `metrics.json` (0600); load-side caps key *length* at 1,000 chars (`metrics.ts:184`) but nothing caps key *count* in memory. This extends baseline Appendix A #16 with concrete injection vectors and matches OTel semconv guidance (`error.type` low-cardinality; `error.message` "NOT RECOMMENDED for metrics"). Smallest fix: a bounded `errorKind` taxonomy keyed in `byModel.errors`; raw messages stay only on the ring-bounded per-request record (already capped at 100, `metrics.ts:348-349`).

**P2-S2 (Low) — Fieldbook storage never requests persistence; whole-origin silent eviction possible.** Evidence: no `navigator.storage.persist()` call anywhere in `public/` (only `estimate()` in `backup.js:186-201`). Per MDN storage-quota/eviction docs, best-effort origins are LRU-evicted whole under storage pressure; Safari additionally deletes script-written storage after 7 days without user interaction. For a workbench whose only copy of notes is IndexedDB, that is silent total data loss. Smallest fix: request `persist()` once at Fieldbook init; surface granted/denied next to the existing quota meter.

#### Frontend / Fieldbook reliability

**P2-F1 (Low/Medium) — IndexedDB connection-per-operation, never closed; latent upgrade deadlock.** Evidence: `sandbox.js:64-75` (`openDb` per op in `dbAll`/`dbPut`/`dbDelete`/`dbPutAll`; no `db.close()`, no `onversionchange` handler anywhere in `public/`); `enforceCaps` (76-87) adds one connection per deleted record and runs on *every* save (133) at up to ~3 Hz (350 ms debounce, 134). Any future `DB_VERSION` bump or multi-tab use hangs `onupgradeneeded` behind the leaked connections (MDN `blocked`/`versionchange` semantics). Smallest fix: memoized single connection + `onversionchange` close; batch `enforceCaps` deletes into one `readwrite` transaction and run it on intervals, not per save.

**P2-F2 (Low) — Immediate-save IndexedDB failures are unhandled rejections / silent data loss.** [severity corrected — see Audit pass 3 (2026-09-04)] Evidence: the debounced path catches (`sandbox.js:134`) but `immediate=true` propagates into fire-and-forget callers — `runRoom` finally (775), `runStudioAttempt` finally (1043), `selectConversation` (140), and a bare `void dbPut(...)` on `pagehide` (1197). Smallest fix: same `.catch(toast)` on the immediate branch.

**P2-F3 (Medium, latent) — `backup.js` import silently reverts newer local records.** Evidence: `backup.js:70-74` skips only exact id+revision duplicates; otherwise the incoming record is unconditionally `put` over the local one (162-177) — importing a stale export overwrites newer local notes, with only an `added` count reported. `revisionOf` already extracts `updatedAt`; lexicographic ISO comparison is never used for ordering. Smallest fix: newer-wins comparison, a `skippedOlder` tally, and a UI line "N newer local notes kept".

**P2-F4 (Low, drift) — `fieldbook/backup.js` is a fourth dead-loaded module, and the live export bypasses its sanitizer.** [severity corrected — see Audit pass 3 (2026-09-04)] Evidence: `sandbox.html:197` loads it; `window.FieldbookBackup` (`backup.js:222`) is referenced nowhere else in `public/` (grep-verified); meanwhile the live export (`sandbox.js:1097` `exportJson`) hand-rolls the same bundle format *without* `sanitizeRecord`'s token/ephemeral-key stripping (`backup.js:9-10,31-37`). Same decision as baseline 8.2: wire it or drop it, moving docs and `test/static/frontend/onboarding-backup.test.ts` together.

**P2-F5 (Medium) — Agent-loop abort/approval races; latent transcript corruption.** Evidence (verified personally): `agent-loop.js` has no `signal?.aborted` re-check between `authorize` (71), `requestApproval` resolution (81), and `execute` (107) — after `stopAll`, auto-approved calls later in the batch still execute; `execute()` receives no signal (107; sandbox caller at `sandbox.js:669`); `authorize` itself sits outside any try/catch (71) so a throwing authorizer rejects `run()` and discards the trajectory. Mid-batch abort leaves later calls without `tool` results (`pendingCalls.length = 0` per call at 70; stub loop at 125-129 covers only the current call) — a transcript that RouteTok's own validator rejects (`sandbox-tools.ts:78`, `server.ts:257-259`). Cross-ref nuance: the corrupting arm is *latent* today because `tool-approvals.js:4-11` `ask()` never rejects; it is a trap for any future approval gate. Smallest fix: re-check the signal after each await; pass signal into `execute`; on abort, stub every unanswered call in the batch.

**P2-F6 (Low) — Live Room/conversation growth is uncapped in-session.** Evidence: caps (500 room messages, 200 turns, 4 MiB results) are enforced only at import (`sandbox.js:1116-1120`); live sessions append without bound (741,773-774). Combined with P2-F1/F2 this is the quota-failure path. Smallest fix: apply the same bounds on live append.

**P2-F7 (Low, UX) — Dashboard `api()` misreports non-JSON error bodies.** Evidence: `app.js:326` runs `await response.json()` before the `!response.ok` check; an HTML/text error (e.g. proxy 502) surfaces as "Unexpected token …" instead of `HTTP 502`. `sandbox.js:99` handles this correctly with `.catch(() => ({}))`. Smallest fix: mirror the sandbox pattern.

**P2-F8 (Info) — Sanitizer divergence across three artifact paths.** [confirmed Low, no exploit — see Audit pass 3 (2026-09-04)] Evidence: `artifactDocument` HTML branch (`sandbox.js:296-299`) doesn't strip `srcset`/`formaction`/`srcdoc`, while `studioPreviewDocument` (993-996) does. Not exploitable — every srcdoc carries `default-src 'none'` and `sandbox=""` — but one shared attribute-deny list would remove the drift class.

#### Performance (additional)

**P2-P1 (Medium at scale) — `/admin/api/status` embeds the entire catalog and is polled every 5 s per tab.** [feasibility corrected — see Audit pass 3 (2026-09-04)] Evidence: `server.ts:1320-1323` (`models: catalog.getModels()` — full array with pricing/tiers/modalities); dashboard `load()` at `app.js:3136-3140`, cadence `app.js:4472-4478` (5 s steady, 1 s degraded, visibility-gated — verified). Each poll also pays server-side `structuredClone` + full serialize per tab. At today's ~426-model OpenRouter catalog ≈ 0.7 MB + ~2.6 ms CPU per poll per tab [cross-ref could not measure a live payload locally — structure confirmed, byte count approximate]; at 2k+ models this is multi-MB/25 ms per poll. Smallest fix: split `models` into a revisioned `GET /admin/api/catalog` with ETag/`If-None-Match` (the `configRevision` pattern already exists); cross-ref verified feasibility — all heavy consumers funnel through `catalogModels()` (`app.js:1344-1346`) and `renderHealth` (650-667), so only `load()` and the new endpoint change.

**P2-P2 (Low) — Transcription multipart parse does a byte-at-a-time 17 MiB copy.** Evidence: `admin-audio.ts:361` — `Uint8Array.from(bytes).buffer` takes the iterator path over up to 17 MiB, then `formData()` and re-serialization copy again (~3-4× peak amplification; concurrency-capped at 2, so bounded). Smallest fix: pass the `Buffer` directly as the `Request` body (valid BodyInit in Node 22).

#### Docs, drift, CI, and ops (new items beyond the corrected attributions above)

**U-3 extension (drift is worse than pass 1 reported):** prod additionally contains `frontend/dashboards/` (5 alternate dashboard sources) and `scripts/build-dashboards.mjs` — an esbuild bundler that imports `esbuild`, which is not even a devDependency, so the script is unreproducible from the repo manifest; prod lacks `.github/` and `CONTRIBUTING.md`; prod `test/` also lags git (missing `model-metadata.test.ts`, `sandbox-tools.test.ts`, `agent-loop.test.ts`; `audio-sandbox.test.ts`/`proxy.test.ts` differ). `AUDIT.md` itself is untracked in the dev repo — same "ops knowledge doesn't travel" problem as AGENTS.md.

**P2-D1 (Low) — CI never builds or boots anything.** `.github/workflows/ci.yml:22` uses `docker buildx build --check` (lint only); no image build/run/`/healthz` smoke, and no native boot smoke after `npm run build`. The exact prod failure class (allowlisted file missing on disk → 500) is CI-invisible. Smallest fix: dependency-free boot-and-GET smoke step reusing the `test/support/process.ts` child-server pattern, or the allowlist-vs-disk static test (5-N3 below).

**P2-D2 (Low) — Supply-chain pinning gaps.** CI actions are tag-pinned (`actions/checkout@v4`, `actions/setup-node@v4`), not SHA-pinned; Dependabot covers npm only (no `docker` ecosystem for the unpinned base image — compounds baseline A#20 — and no `github-actions` ecosystem; `tsx` major bumps inconsistently un-ignored). Note the sibling `deploy/local-stt/compose.yml:5` *is* digest-pinned — the two shipped stacks are inconsistently hardened.

**P2-D3 (Low) — `/metrics` exposition is entirely undocumented.** Zero occurrences of `routetok_`/`agentrouter_router_` in docs/README; `docs/api.md:68` lists bare `GET /metrics` with no family names or dual-prefix policy. Any future prefix migration would blindside operators.

**P2-D4 (Low) — Doc mismatches found this pass:** `docs/architecture.md:43-44` duplicated contradictory Fieldbook-IndexedDB bullets (merge artifact); `docs/troubleshooting.md:47-49` never mentions the 500 "Dashboard assets are unavailable" mode (the live prod failure); `docs/configuration.md` §Routing Policy names no values — all defaults/bounds (`config.ts:6-18,66-75`) undocumented; the 500,000-char transcript cap and the 8-branch 429 shed (`server.ts:735-739`) undocumented; `CHANGELOG.md:7` "script-tag mounts" wording papers over the dead-load; `scripts/benchmark-free-models.mjs:208` links `/benchmarks/free-models.json` but writes `free-model-benchmark.json` (259) to a path nothing serves, and is referenced nowhere; two unreferenced `docs/images/*.png` (~254 KB); `package.json` description still says "model sandbox".

### Test & coverage — additions to baseline Section 5 (all confirmed absent this pass)

11. **No SSE split-invariance fuzz/property test** — and `StreamSanitizer`/`streamEventBlocks` are not exported from `proxy.ts`, so only `StreamInspector` is testable. Recommended: seeded-PRNG (mulberry32) split-at-every-byte-offset harness asserting chunking invariance, round-trip SSE well-formedness, and no `billing.*` leakage (~60 LOC, zero deps; prior art: rexxars/eventsource-parser fixtures, WHATWG event-stream interpretation).
12. **`t.mock.timers` unused** (stable API since Node 20.4/22): circuit half-open transition (`router.ts:129-136`) and metrics save debounce (`metrics.ts:537-544`) are currently untestable without real sleeps. RouteTok uses global timers, so mock timers intercept cleanly.
13. **No allowlist-vs-disk static test** — nothing parses `server.ts:1100-1123` and asserts disk presence (the live prod-500 class); also no HTTP GET test for the four allowlisted dashboard modules (`proxy.test.ts:363-371` covers only sandbox assets).
14. **No Prometheus golden-file/format test** — `metrics.prometheus()` (447-527) is never invoked in tests; a ~30-line line-format validator + checked-in golden file would lock dual-prefix parity, HELP/TYPE pairing, and label escaping.
15. **Eight admin endpoints never hit over HTTP**: `/admin/api/attempts/decode`, `/route/simulate`, `/models/visibility`, `GET /providers/credits`, credential PUT/DELETE, `/catalog/refresh`, `/config/proposals/generate` (no coverage at all). HTTP wiring/auth/validation unexercised.
16. **Origin gate and wrong-credential 401s untested** — no test sends an `Origin` header (3.5's defense has zero regression protection); only *missing*-credential 401s are asserted; env-key + managed-key simultaneous auth untested.
17. **Sandbox concurrency shed (429 + `retry-after: 1`, `server.ts:735-739,841,897`) untested** — the server's only load-shedding path.
18. **`writeStreamError` synthesized mid-stream error untested** (`proxy.ts:913-928` via 1638) — the client-visible contract when a committed stream stalls; only upstream-sent error events are covered.
19. **`GET /healthz` never fetched by any test** — a redaction/shape regression on the only unauthenticated endpoint would be invisible.
20. **Attempt-summary encoder↔decoder round-trip not directly tested** (low risk; both directions shape-locked separately).

### Roadmap additions (pass 2)

- **P1: Fix the Responses `error`-event drop (P2-1).** Effort S. Active client-visible data loss on an advertised endpoint; include the unit test.
- **P1: Anthropic sanitizer denylist + inspector generalization (P2-2, P2-3).** Effort S. Future-proofs the crown-jewel stream path against documented API evolution.
- **P2: Revisioned `/admin/api/catalog` + ETag; remove models embed from `/status` (P2-P1).** Effort M. Feasibility verified (two consumer touch-points).
- **P2: Bounded `errorKind` taxonomy for metrics (P2-S1).** Effort S–M. Supersedes baseline P2 "error *class* persistence" with concrete injection vectors.
- **P2: Fieldbook reliability bundle (P2-F1/F2/F3/F5 + `storage.persist()`).** Effort M. All browser-side; the import-clobber (F3) is the only silent-data-loss item.
- **P2: Boot-time static-asset check + CI boot smoke (2.8, P2-D1, 5-N13).** Effort S. Kills the live prod-500 class in both places.
- **P2: Node hardening bundle:** explicit `createServer` timeouts (`keepAliveTimeout: 5_000, headersTimeout: 30_000, requestTimeout: 120_000`), inter-chunk stall timer in `readRequestBody`/`readJson`, `closeIdleConnections()` in shutdown, second-signal force-exit. Effort S. All dependency-free; SSE-safe (requestTimeout governs reception only).
- **P3: Scoped health reset on credential change (P2-5); image-gate atomic acquire (P2-4).** Effort S each.
- **P3: OpenRouter `pricing.overrides[]` + `input_cache_write_1h` parsing into `pricingTiers`** (catalog.ts:168-169,197; OpenRouter docs list conditional/long-context pricing now) — cost-accuracy only. Note: OpenRouter no longer sends `X-RateLimit-*` on success responses; RouteTok only forwards them when present (`proxy.ts:190-205`), so no action.
- **P3: Circuit-transition webhook (`ALERT_WEBHOOK_URL`, event+model only, TTL dedup)** — LiteLLM alerting pattern; ~40 lines, off by default, consistent with the no-bodies rule.
- **P3: Attempt-content retention TTL + opt-out toggle** (P2-13 + baseline A#15; LiteLLM/OTel treat body capture as opt-in).

### Executive top-10 — changes from pass 1

Changed. New #1: **P2-1** (Responses error-event drop — the only *active* client-visible data-loss bug found). Pass-1 #1 (half-open stampede) becomes #2; pass-1 #2 (stream-killing deadline, now sharpened by the 600 s config clamp) becomes #3. Prod-drift (#3) stands but is partially stale once the boot-check/CI smoke lands. New entries to the list: **P2-P1** (full-catalog status polling) and **P2-4** (image-gate TOCTOU, paid-spend path). Demoted out of the top 10: catalog deep-clones (recalibrated — ~1.5 ms at today's real catalog sizes) and metrics/Prometheus divergence (unchanged Low). The pass-1 ordering otherwise stands.

### Appendix A updates (apply from this pass onward)

| # | Change |
|---|---|
| 11 | Correct: modules total ~40 KB; tags at `index.html:643-645`; api.md attribution removed; add fourth dead module `fieldbook/backup.js`. |
| 15 | Reinforced: default-on body retention deviates from LiteLLM/OTel opt-in norms → promote the opt-out toggle to P3 roadmap; add TTL (P2-13). |
| 16 | Extended: upstream-controlled header *and* body-snippet injection vectors identified (P2-S1); fix is the bounded `errorKind` taxonomy. |
| 20 | Extended: add Dependabot `docker`/`github-actions` ecosystems and SHA-pinned actions (P2-D2). |
| 21 (new) | Responses `error` event dropped — proxy.ts:642-646 — High |
| 22 (new) | Anthropic sanitizer allowlist drops unknown event types — proxy.ts:652-666 — Medium (latent) |
| 23 (new) | Full-catalog embed in `/admin/api/status` polled 5 s/tab — server.ts:1322-1323; app.js:3136-3140,4472-4478 — Medium (at scale) |
| 24 (new) | Image-generation gate TOCTOU — admin-images.ts:115-126,151 — Low/Medium |
| 25 (new) | `router.reset()` wipes all providers on single credential change — server.ts:1427 — Low/Medium |
| 26 (new) | backup.js import reverts newer local records — fieldbook/backup.js:162-177 — Medium (latent) |
| 27 (new) | Agent-loop abort races / latent transcript corruption — fieldbook/agent-loop.js:67-129 — Medium/Low |
| 28 (new) | IndexedDB connection leak + per-keystroke full sweep — sandbox.js:64-87,133 — Low/Medium |
| 29 (new) | Sandbox 1 MiB body cap vs documented 2 MiB payload bounds — server.ts:178-188,731 — Low |
| 30 (new) | No boot smoke / image build / allowlist-disk check in CI — .github/workflows/ci.yml — Low/Medium (deployment) |

### Appendix B2 — pass-2 research sources (primary anchors)

- OpenAI Responses API reference (streaming events incl. `ResponseErrorEvent` `type:"error"`, `response.failed`, background mode): https://developers.openai.com/api/reference/resources/responses (verified live this pass)
- Anthropic streaming/versioning ("handle unknown event types gracefully"), errors/long-requests, thinking, refusals-and-fallback docs: https://platform.claude.com/docs/en/build-with-claude/streaming et al.
- OpenRouter models schema (`pricing.overrides`, `input_cache_write_1h`), limits (rate-limit headers only on 429): https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md , /docs/api_reference/limits.md
- MDN IndexedDB (`blocked`/`versionchange`, Using IndexedDB), storage quotas/eviction, `StorageManager.persist`; WebKit ITP 7-day eviction; state partitioning: developer.mozilla.org, webkit.org
- WHATWG SSE event-stream interpretation; rexxars/eventsource-parser fixtures (chunk/CRLF regressions): html.spec.whatwg.org, github.com/rexxars/eventsource-parser
- Node test runner: MockTimers (v20.4+/22), snapshot testing (v22.3+, experimental under 22.x): nodejs.org/api/test.html
- Node http server options incl. `keepAliveTimeoutBuffer` (≥22.19.0), `closeIdleConnections`, `clientError`; defaults runtime-verified on Node 22.19.0: nodejs.org/api/http.html
- OTel error semconv (`error.type` low-cardinality; `error.message` not for metrics): opentelemetry.io/docs/specs/semconv/registry/attributes/error/
- LiteLLM budgets/alerting (reservation, `budget_exceeded`, webhook TTL dedup); Langfuse masking (body capture as explicit product surface): docs.litellm.ai, langfuse.com
- Kubernetes liveness/readiness/startup probe conventions: kubernetes.io
- Prometheus exposition format; promtool: prometheus.io/docs/instrumenting/exposition_formats/
- Live measurement: OpenRouter `/api/v1/models` returned 426 models (~706 KB) on 2026-09-04; local structuredClone benchmarks (0.31 MB ≈ 1.3 ms; 1.23 MB ≈ 5.6 ms; 3.07 MB ≈ 12.2 ms).

### Pass-2 caveats

- UNCERTAIN items carried: P2-12's undici abort-message propagation; P2-3's real-world frequency (depends on upstream server-tool usage); P2-P1's exact payload bytes (no live catalog on disk to measure); whether prod's `frontend/dashboards/`/`public/dashboards/` are intentional WIP (operator decision).
- Items verified by delegated agents but not re-read line-by-line by me are confined to: `app.js` render internals, `backup.js` internals, and the test-tree absence claims (which two agents independently confirmed). All load-bearing server-side findings were verified personally.
- No files were modified except this report; no restarts, no traffic to 8787, no builds run.

---

## Audit pass 3 (2026-09-04)

Third-generation audit. Same HEAD (`cddfbdf` — no code moved since passes 1-2, verified `git log`; all pass-2 line cites therefore re-derive exactly). Method: independent re-verification of every pass-2 finding (spot-reads personally: P2-1 allow-rule `proxy.ts:643-645`, inspector `:736`; image/audio gates `admin-images.ts:115-126` vs `admin-audio.ts:440-444`), five parallel research workstreams (stream-path stress-test + lone-`\r` + P2-12; gallery/showcase + UX/a11y deep-dive; server P2-4–P2-11 re-verify; security + drift + docs; upstream-drift + perf + tests), and three parallel cross-reference verifiers that resolved four inter-agent conflicts (P2-1 fix shape, P2-2 forward-vs-drop, 3.3 `manual`-vs-`error`, 4.1 clone sites, P2-S1 vector-B strength, P2-P1 strip-vs-project). No live verification on 8788 was performed (out of scope for a read-only pass). No secrets appear below.

### Delta table — disposition of every pass-2 finding

| Pass-2 finding | Verdict | Notes (current evidence) |
|---|---|---|
| P2-1 Responses bare `error` drop (High) | CONFIRMED, sharpened | `proxy.ts:643-644` drops flat `{type:"error"}` (no `error` key); inspector `:736` flags it; `pipeStream :1624-1631` ends with no frame; `writeStreamError` unreachable (only `catch :1635-1639`). Cross-ref: nested `{"type":"error","error":{...}}` (seen in production per LiteLLM#29223) already passes via `Boolean(value.error)` — fix is exactly `type === "error" \|\|` at `:644`. Web-verified against official streaming-events docs by two agents independently. |
| P2-2 Anthropic allowlist | DOWNGRADED to latent-only | The 8 forwarded types (`proxy.ts:652-661`) exactly equal the documented Messages top-level set; deltas (`text_delta`, `citations_delta`) live *inside* `content_block_delta`. Nothing documented is dropped today. Cross-ref REJECTS pass-2's forward-unknown fix: unknown future types could carry embedded `model`/internal fields past the rewrite — keep the allowlist, add a counter/log for unknown types. P1-roadmap urgency removed. |
| P2-3 Inspector misses server-tool/citation output | CONFIRMED | `proxy.ts:744-745,753-759`. Frequency assessed: zero `server_tool_use`/`web_search_tool_result` hits in `src/`, `test/`, `docs/` — Low trigger likelihood today, rising with server-tool adoption. |
| P2-4 Image-gate TOCTOU | CONFIRMED | `admin-images.ts:115,117,126,150-151`. |
| P2-5 Full `router.reset()` on credential change | CONFIRMED | `server.ts:1427`; `router.ts:205-207`; only other caller is intentional `:1574-1576`. |
| P2-6 1 MiB cap vs 2 MiB legal payload | CONFIRMED | Math verified: 4×500k chars ≈ 2 MiB; even 2 capped branches exceed 1 MiB — any legal 2+-branch max-transcript request fail-closes. |
| P2-7 Responses model substitution | CONFIRMED, scoped | Streaming-only (`proxy.ts:647` envelope vs nested `response.model`); non-stream `:1463` rewrite is correct. |
| P2-8 Case-sensitive content-type sniffing | CONFIRMED | `proxy.ts:857,1423`; `catalog.ts:497`. |
| P2-9 `retry-after` lost on final 429 | CONFIRMED | Skip `:1150` vs length tests `:1223,1284`; fallthrough `:1488-1512` drops header. |
| P2-10 `cost: null` → $0.00 reported | CONFIRMED | `proxy.ts:262,299-302,270`; guards `:1394,1468`; `:826-829`. |
| P2-11 Streaming latency = total time | CONFIRMED | `proxy.ts:1414,1472`; `router.ts:155-157,235`. |
| P2-12 Deadline double-record | CONFIRMED plausible (Low) | Code-reading confirms two `recordTransientFailure`s for one expiry; cross-ref: fix (observe `controller.signal.aborted` first, `break` not `continue` at `:1351-1358`) preserves client-disconnect abort (`:1115-1128,1162,1636`). Undici propagation remains test-unverified. |
| P2-13 Retention TTL | CARRIED (not re-read; HEAD unchanged, stands) | — |
| P2-S1 Metrics error-key injection | CONFIRMED, vector B negligible | Vector A (content-type throw `:858` → `:1351-1354` → `:361-379` → `metrics.ts:330-331`) material. Vector B (`JSON.parse :304-307`): V8 message embeds token/position only, never the body — negligible. Fix priority is the unbounded `errors` map + vector A taxonomy. |
| P2-S2 No `storage.persist()` | CONFIRMED | No call anywhere; only `estimate()` in `backup.js:187`. |
| P2-F1 IDB connection-per-op | CONFIRMED | `sandbox.js:64-87,130-135`; per-turn immediate saves `:775,1043`. |
| P2-F2 Immediate-save rejections | DOWNGRADED to robustness nit | Cross-ref REJECTED "stuck `saving` entry" (`save() :133` deletes before `dbPut`; debounced path catches `:134`). Residual: `finally`-block immediate saves (`:742,748,775,1043`) can throw unhandled. Fix: `.catch(toast)` at those sites. |
| P2-F3 Import clobber | QUALIFIED | Live `importData` (`sandbox.js:1127`) re-ids via `uid()` — safe. Only the unused `mergeBundle` API (`backup.js:167-170`) is last-write-wins + unsanitized. Fix there: `sanitizeRecord` + revision-newer-wins + `skippedOlder` tally. |
| P2-F4 Dead-load + export bypass | CONFIRMED, (b) DOWNGRADED | Dead-load stands (`sandbox.html:197`, zero refs in `sandbox.js`). Bypass is structural-hygiene only: tokens live in `state.token` (`sandbox.js:18`), never in `state.conversation` (`:104-106`) — no secret flows today. Fix: route `exportJson` through `exportBundle`. |
| P2-F5 Agent-loop abort races | CONFIRMED, refined | `agent-loop.js:67-129`; signal dropped at `sandbox.js:669`; post-execute abort checked only at next loop top; unabortable `save()` in `studio-chat.js:76`. Latent (current `ask()` never rejects) — trap for future gates. |
| P2-F6 Live room growth uncapped | CONFIRMED | `sandbox.js:773-774` vs import-only cap `:1116`. |
| P2-F7 `api()` JSON-before-ok | CONFIRMED | `app.js:326` vs correct `audioFetch :345-347` pattern. |
| P2-F8 Sanitizer divergence | DOWNGRADED to Low (no exploit) | `sandbox=""` (`:306`) + `default-src 'none';form-action 'none'` (`:300-301`) + inner-`iframe` removal leave no network/script/submit path. Pure hygiene: add `srcset,formaction,srcdoc` to the `:298` strip list. |
| P2-P1 Full-catalog `/status` polling | CONFIRMED, feasibility CORRECTED | Embed (`server.ts:1320-1323`) + cadence (`app.js:3136-3140,4472-4478`) confirmed. But "strip `models`" breaks ≥10 `catalogModels()` consumers (chat picker `:1286`, browser `:1563`, detail `:1709,3295`, counts `:1941`, toggles `:3273,3309,3330`, health `:650-667` via `:4419`). Fix must be a projected/subset field or revisioned endpoint, not deletion. |
| P2-P2 Audio byte-at-a-time copy | CONFIRMED | `admin-audio.ts:361` (cap `:11`, first copy `:67-95`). Fix: pass `Buffer`/view as body. |
| U-3 Drift worse than pass 1 | CONFIRMED | 4 missing modules, leftovers, test lag all re-verified by direct diff. `dashboards/` verdict: UNCERTAIN STANDS, strengthened — zero `build-dashboards\|dashboard-switcher` hits anywhere in the dev checkout (`.github/`, `docs/`, manifest), so no dev-side wiring exists; WIP-vs-stale unresolvable from dev alone. |
| P2-D1 CI no boot smoke | CONFIRMED | `ci.yml` 22 lines, `buildx --check` only. |
| P2-D2 Pinning gaps | CONFIRMED | Tag-pinned actions; `dependabot.yml` npm-only. |
| P2-D3 `/metrics` undocumented | CONFIRMED | Zero `routetok_` hits in docs. |
| P2-D4 Doc mismatches | CONFIRMED (all 8) | Arch dup bullets, troubleshooting missing 500-mode, config defaults, `api.md:90` stale 4 MiB (code: unlimited, `server.ts:618`), CHANGELOG wording, benchmark path mismatch, 2 orphan PNGs, package.json description. |
| Test gaps 11-20 | CONFIRMED (8 sampled still absent; 2 carried) | No fuzz harness, no `t.mock.timers`, no allowlist-vs-disk test, `prometheus()` never invoked, no Origin tests, no `/healthz` fetch, `writeStreamError`/`StreamSanitizer` untested, sandbox 429 shed unasserted. |
| Pass-1 baseline (2.1-2.9, 3.x, 4.x, 7, 8.1) | All CONFIRMED (spot-read) | Two cite/fix corrections: 4.1 waste is `proxy.ts:1392,1466` (`getModels().find`), not `:1536` (the good `resolve()` pattern, `catalog.ts:389-391`); 3.3 fix value is `redirect: "manual"` (the POST convention, `proxy.ts:1187`), not `"error"` (the GET-metadata convention, `catalog.ts:492`, `credits.ts:51`) — `"error"` would throw outside the existing 3xx→502 mapping (`admin-images.ts:137`). |

### NEW findings (pass 3)

**N-R1 (Info) — Lone-`\r` mid-buffer question RESOLVED: no bug.** `streamEventBlocks` (`proxy.ts:571-580`) holds a split `\r\n\r\n` tail in `remainder` across `push()` calls (`:605-606,697-698`); interior lone `\r` is normalized per SSE CR/CRLF handling (`:576`). The pass-2 UNVERIFIED flag closes with no fix. (Cross-ref upheld.)

**N-G1 (Info) — Gallery/showcase serving is sound; showcase manifest is an empty stub.** `public/image-gallery/index.html` is script-free (19 cards, skip link `:11`, `aria-label :25`, eager-first-4/lazy-rest, `alt` text); `gallery.css` has `:focus-visible`, `prefers-reduced-motion`, `forced-colors`, responsive breakpoints; HTML/manifests served `no-store` + `script-src 'none'`, assets `immutable` (`server.ts:1146-1150`); gallery/showcase fetches use bare `fetch()` (`sandbox.js:1137,1147,1149`) — token attaches only via `authFetch()` (`:89-92`), so no token leak; `fieldbook/showcases/manifest.json` is `{"version":0,"projects":[]}` with strict client-side validation. No fix.

**N-U1 (Low, polish bundle) — Fieldbook/dashboard UX/a11y notes; no blockers found.** (a) Toast-only errors: single `role=status` (`sandbox.html:196`), 2.4 s overwrite (`sandbox.js:38`), 40+ call sites — rapid errors clobber; queue toasts, assertive for errors. (b) No focus management on `setMode` (`sandbox.js:1129` toggles `hidden` only) or turn completion — move focus to the new view heading/status. (c) Contrast: verify `--muted` small text and `#c47750` rust / `#d8c89e` cost against WCAG AA 4.5:1. (d) Destructive actions: `confirm()`-guarded but single-undo (`sandbox.js:1173,1182,1194`; `snapshots.pop()` drops the popped snapshot) — keep a 1-deep undo buffer. (e) Studio-breakpoint settings hidden (`sandbox.css:37`, 901–1400 px) — expose via drawer. (f) `forced-colors` partial (lane bars/status color-only) — add text labels. (g) English-only strings throughout — note only. None blocks task completion or loses data; batch as polish.

**N-C1 (Info) — Upstream conformance re-check: no drift since 2026-09.** OpenAI Responses/Chat streaming (incl. `error`-event shape, reasoning-field superset `proxy.ts:772-787`, `writeStreamError` byte shapes `:913-928`), Anthropic event/versioning set (`proxy.ts:652-666` vs "handle unknown gracefully"), and OpenRouter schema/rate-limit policy (1h-cache/`overrides` ignored at `catalog.ts:168-199` — already P3 roadmap; success responses carry no `X-RateLimit-*`, consistent with `proxy.ts:190-205,1218-1239`) all CONFIRMED-current with doc URLs in Appendix B3. Doc note: OpenRouter "150" is a schema example, not a catalog size — pass-2's live 426-model measurement stands uncompared.

### Executive top-10 — changes from pass 2

Unchanged. P2-1 remains #1 (only active data-loss bug; fix now pinned to the exact one-liner). The P2-2 downgrade removes its P1-roadmap urgency (keep as latent hardening: log unknown Anthropic types). P2-P1 stays ranked but its fix is re-scoped (projection, not strip). No new item enters the top 10 — N-U1 is polish, N-G1/N-R1/N-C1 are confirmations.

### Appendix A updates (apply from this pass onward)

| # | Change |
|---|---|
| 3 (3.3) | Fix value corrected: `redirect: "manual"` on the image/audio POST fetches (`admin-images.ts:131`; `admin-audio.ts:307,400,495,514`), matching `proxy.ts:1187`; `"error"` is the GET-metadata convention and would throw outside the 3xx→502 mapping. |
| 9 (4.1) | Cite corrected: waste is `proxy.ts:1392,1466` (`getModels().find` per request); `:1536` + `catalog.ts:389-391` (`resolve()`) is the fix pattern. |
| 22 | Downgraded to latent-only: allowlist == documented set; keep allowlist + log unknown types (forward-unknown rejected — model-field rewrite bypass risk). |
| 23 | Re-scoped: revisioned `/admin/api/catalog` or projected subset field — full strip of `models` from `/status` breaks ≥10 `catalogModels()` consumers. |
| 28 | P2-F2 downgraded to robustness nit (no stuck entry); fix is `.catch(toast)` on `finally`-block immediate saves. |
| 29 (new detail) | P2-F4(b) downgraded: bypass real, no live secret flows (tokens outside `state.conversation` by construction). |
| 30 (new detail) | P2-F8 downgraded to Low: no exploit path (sandbox + `default-src 'none'`); single shared strip list. |
| 31 (new) | UX/a11y polish bundle (N-U1): toast queue, focus management, contrast verification, 1-deep undo, Studio-breakpoint settings, forced-colors labels — Low/note-only. |

### Appendix B3 — pass-3 research sources (primary anchors)

- OpenAI streaming-responses guide (`event.type === "error"` handler) + Responses streaming-events reference (`error` fields `code/message/param/sequence_number/type`): https://developers.openai.com/api/docs/guides/streaming-responses , https://developers.openai.com/api/reference/resources/responses/streaming-events
- Nested-vs-flat error shapes in the wild: https://github.com/BerriAI/litellm/issues/15785 (flat), https://github.com/BerriAI/litellm/issues/29223 (nested), https://github.com/openai/openai-dotnet/issues/881
- Chat streaming schema (no official `reasoning_content`; DeepSeek/OpenRouter extension): https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events , https://docs.vllm.ai/.../openai_chat_completion_with_reasoning_streaming.html
- Anthropic streaming/versioning ("new event types may be added… handle unknown event types gracefully"), error example byte-shape: https://platform.claude.com/docs/en/build-with-claude/streaming
- OpenRouter models schema (`input_cache_write_1h`, `overrides` semantics) + limits (no `X-RateLimit-*` on success): https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md , https://openrouter.ai/docs/api/reference/limits
- WCAG 2.2 quickref (1.4.3 contrast, 4.1.3 status, 2.4.3/2.4.7 focus), ARIA live regions, `prefers-reduced-motion`, storage quotas/eviction (`persist()`): w3.org/WAI, developer.mozilla.org
- Node `http` server options (request-phase-only `requestTimeout`, `keepAliveTimeoutBuffer ≥22.19.0`): nodejs.org/api/http.html

### Pass-3 caveats

- UNCERTAIN items carried: P2-12's undici abort-reason propagation (untestable read-only); P2-3's real-world frequency (low today by zero-hit grep); P2-P1's exact payload bytes (no live catalog measured); prod `dashboards/` intent (no dev-side wiring exists — operator call required).
- Personally re-read this pass: P2-1 allow-rule/inspector/pipeStream, image/audio gates, plus all cross-ref conflict sites. Delegated-but-not-personally-re-read: gallery/UX line cites, docs-mismatch lines, test-gap absence greps (each confirmed by ≥2 independent agents).
- Read-only except this report (plus 7 one-line in-place markers pointing here); no restarts, no traffic to 8787, no builds/tests run.

---

## Audit pass 4 (2026-09-04)

Fourth-generation audit. Same HEAD (`cddfbdf` — no code moved since passes 1-3, re-verified `git log`). **This pass adds the first live runtime verification in the audit chain**: three throwaway isolated instances were spawned (child `node --import tsx src/server.ts` with blanked provider keys, temp DATA_DIR, seeded `requestTimeoutMs`, and a mock AgentRouter upstream on ephemeral ports; harnesses at `/tmp/opencode/routetok-p4/harness*.mjs`, all teardown-clean, prod/8787 never touched). Method: personal re-verification of every pass-3 cite (spot-reads `proxy.ts:617-669,688-831,833-928,1333-1645`, `router.ts:118-212`), five parallel research workstreams (Responses error-frame contract; real-world failure frequency; circuit half-open precedents; streaming-timeout precedents; SSE buffer/error-frame prior art), three parallel cross-reference verifiers (client truncation-response behavior — full; post-commit error-frame bytes — **returned empty, not re-dispatched per operator instruction**, bytes rest on the verified fifth workstream anchors; circuit fix-shape endorsement — full), plus personal fetch-verification of openai-node `src/core/streaming.ts` and review of openai-python `src/_streaming.py`. No code modified; no builds/tests run; no secrets below.

### Delta table — disposition of every pass-3 finding

| Pass-3 finding | Verdict | Notes (current evidence) |
|---|---|---|
| P2-1 Responses bare error drop | CONFIRMED-LIVE, family WIDENED | See N4-1. Live-reproduced (EXP1): flat `{"type":"error",…}` following a committed delta is silently dropped; client gets a clean EOF with `x-router-terminal: stream_committed`, no frame, no `response.completed`. Official schema confirmed (ResponseErrorEvent flat shape); openai-node throws `APIError` on `event:"error"`/`data.error` (verified in source) — so the drop converts a should-be-error into silent success. Fix is `\| type === "error"` at `proxy.ts:644` (prefix already preserved at `:648`), whose byte output matches what openai-node/anthropic SDKs parse. |
| P2-2 Anthropic allowlist | CARRIED (stand) | No code movement; no new evidence for or against. |
| P2-3 Inspector misses server-tool/citation | CONFIRMED; frequency assessed LOW | Research survey found zero real-world `server_tool_use`-output incidents; `proxy.ts:788-791` marks `function_call`/`tool_call` meaningful only. Stays Low; revisit with tool-using Responses adoption. |
| P2-4 Image-gate TOCTOU | CARRIED | Unchanged. |
| P2-5 Full router reset on credential change | CARRIED | Unchanged. |
| P2-6 1 MiB vs 2 MiB transcript cap | CARRIED | Unchanged. |
| P2-7 Responses model substitution | CARRIED | Unchanged. |
| P2-8 Case-sensitive content-type sniffing | CARRIED | Unchanged. |
| P2-9 `retry-after` lost on final 429 | CARRIED | Unchanged. |
| P2-10 `cost:null` → $0.00 | CARRIED | Unchanged. |
| P2-11 Streaming latency = total time | CARRIED | Unchanged. |
| P2-12 Deadline double-record | CONFIRMED-LIVE; UNCERTAIN CLEARED | See N4-3. Empirically reproduced and mechanism pinned. The undici abort-reason propagation question (pass-3 caveat) is resolved at the RouteTok layer: the string "request deadline exceeded" reaches both the fetch-abort path and the reader-abort path records. |
| P2-13 Retention TTL | CARRIED | Stands (HEAD unchanged). |
| P2-S1 Metrics error-key injection | CONFIRMED-LIVE (vector A) | EXP5: `text/plain` upstream → 502 `fallback_exhausted`, summary has `good-model s:200 transient_error`, and the upstream-controlled string is what persists in `byModel.errors` (`metrics.ts:330-331`). Vector B stays negligible (V8 positions-only). |
| P2-S2 No `storage.persist()` | CARRIED | Unchanged. |
| P2-F1..F8 Frontend findings | CARRIED | `public/` untouched since pass 3; no re-read this pass (no code movement). |
| P2-P1 Full-catalog `/status` polling | CONFIRMED; bytes now measured | EXP4: `/admin/api/status` = **17,783 bytes** total; models live at `catalog.models` (11 entries on a fallback-only instance), NOT a top-level key; payload scales with `catalog.models`. Fix stays the projected/subset or revisioned endpoint (strip breaks ≥10 consumers, pass-3 note). |
| P2-P2 Audio byte-at-a-time copy | CARRIED | Unchanged. |
| U-3 Prod drift / `dashboards/` | CARRIED | Prod untouched this pass; `dashboards/` intent remains an operator call (WS balance: no dev-side wiring exists). |
| P2-D1..D4 CI/metrics/docs | CARRIED | Unchanged. |
| N-G1 / N-U1 / N-C1 / N-R1 | CARRIED | Confirmation posts, unchanged. |
| Test gaps 11-20 | CARRIED | Unchanged; add: no test exercises `requestTimeoutMs` overall-deadline abort (directly relevant to N4-2/N4-3 fixes), no test asserts half-open single-probe (N4-6). |

### NEW findings (pass 4)

**N4-1 (High) — Live-confirmed commit-then-silent-truncation on the Responses path; family is three-headed, not one frame.** EXP1: after a committed `response.output_text.delta`, a flat `event:error` frame (seq 1) is dropped (`proxy.ts:643-644` allow predicate rejects `type:"error"` when there is no `value.error` object); `pipeStream` then ends the response cleanly (`:1629-1634` → `response.end()` at `:1631`) — no frame, no `response.completed`. The inspector *knows* (`:736-738` sets `upstreamError` on `type==="error"`/`response.failed`/`value.error`) but `writeStreamError` is only reachable from the `catch` (`:1635-1643`), never from the normal-exit-with-error path. So three distinct cases all silently become success for the client:
1. flat `type:"error"` frames (dropped by the sanitizer),
2. `response.failed` (inspected, then `response.end()` with no frame),
3. clean EOF with no terminal event (`stream ended without a terminal event` error at `:1632-1633`, recorded as a transient failure at `:1407-1411` for metrics/health, but **no bytes** to the client).
Cross-reference workstream confirmed via maintained sources that every mainstream client silently accepts ALL THREE as success today: openai-node and openai-python end their stream loops cleanly on EOF without any terminal-sentinel check (openai-node `streaming.ts` `after the for await: done=true`; openai-python `_streaming.py`: `[DONE]` is `break`-only and `data.error` is the only error hook); anthropic-sdk-python `get_final_message()` does not validate `message_stop`; langchain-openai's Responses converter returns success on no-terminal (issue #39039); vercel/ai `onEnd` fires with `finishReason: undefined` and consumers persist the response (issue #17500); openai-agents-python treated `response.failed` as a usable final response pre-0.15.x (issue #3106). Fix (three lines, one code path): (a) `type === "error"` added to the `:644` predicate; (b) in `pipeStream`'s normal completion, when `error` is non-null, write the protocol-correct error frame before `response.end()` (instead of `:1631` running bare); (c) make `writeStreamError` reason-accurate (N4-2) and, for OpenAI-Chat, append `data: [DONE]` (N4-8). Severity: HIGH (silent data loss on the most common failure class; was previously scoped to one frame shape).

**N4-2 (Medium-High) — Overall deadline truncates committed streams LIVE, and the client-facing frame mislabels the cause.** EXP2 (requestTimeoutMs 5000): mock committed a chunk then streamed for 8 s; router truncated at **5040 ms** with status 200, `x-router-terminal: stream_committed`, wrote the canned frame `{"error":{"message":"Upstream stream stalled or disconnected","type":"server_error","code":"stream_interrupted"}}` (`proxy.ts:913-928`), recorded `errors: {"request deadline exceeded":1}` in `byModel` and a transient health failure. So the wire reason-string is the canned idle text while the real cause (deadline) is only in metrics — a truthful frame would let clients back off/retry correctly. Industry precedent (verified): committed-stream governance should be **idle/activity-based**, not fixed wall-clock — nginx `proxy_read_timeout` is per-read idle, Envoy explicitly says `request_timeout` is "not compatible with streaming" (idle recommended), LiteLLM provides dedicated idle bounds (`stream_idle_timeout`, `ttft_timeout`) and delivers reason-mapped error frames. The pass-2 recommended fix (detach the overall deadline at commit; keep client-close `proxy.ts:1119-1128,1636` + `streamIdleTimeoutMs` as the sole post-commit bound; `clearTimeout` in the same synchronous commit path to avoid a late-fire race) is endorsed. Fix is server-side `proxy.ts` with `docs/api.md` timeout-note update.

**N4-3 (Medium) — P2-12 double-record reproduced and pinned; fix shape confirmed.** EXP3 (headers-arrived, non-semantic chunks every 400 ms, deadline 5 s): result 504 `request_timeout` at 5046 ms; `x-router-attempts: 2`; summary = `[good-model s:200 transient_error, other-model s:null transient_error]`; **one** upstream call (other-model never contacted — its fetch rejects synchronously on the already-aborted `AbortSignal.any` at `proxy.ts:1162`); `byModel` shows BOTH `openai:good-model` and `openai:other-model` with `{"request deadline exceeded":1}`; health shows failures/consecutiveFailures 1/1 on BOTH models. Mechanism: the prepareStream catch (`:1341-1358`) records `attempt(200, …)` then `continue`s (`:1358`) without checking `controller.signal.aborted`, so the next candidate enters the loop, its fetch throws immediately on the already-aborted signal, the fetch-catch (`:1200-1212`) records a second attempt (status null) and `break`s. This is exactly pass-2's "one 'failure' that never actually ran", and it costs a spurious `recordTransientFailure`/circuit credit on a healthy sibling. Fix (one line in the prepareStream catch, mirroring `:1211`/`:1442`): after recording the attempt, `if (controller.signal.aborted) break;` else `continue;`. Resolves the pass-3 "undici propagation" UNCERTAIN: the recorded error string is "request deadline exceeded" on both abort paths.

**N4-4 (Info) — Real-world failure frequencies: truncation is the big one, flat frames are rare.** Surveying 2025-2026 issue traffic across LiteLLM/Codex/OpenRouter-consumer repos: flat Response `error` frames mid-stream are uncommon and mostly first-event/openai-origin (LiteLLM#29223 nested error as *first* event — would already fall back pre-commit); the dominant failure classes are **streams ending with no terminal event / empty-delta resets** (openai/codex#4302,#3924; cherry-chat/openclaw OpenRouter empties; litellm#9296 Groq empty delta; qwen-code#2402 duplicate empty tool-call chunks) and provider-reported mid-stream failures **after** output committed (openai-python issue pi#6019). Also OpenRouter documents a nonstandard `finish_reason:"error"` (pydantic-ai#2844). Upshot: N4-1's family fix (emit a truthful frame on any committed-stream error exit) matters more than the single-frame relay — put engineering weight there.

**N4-5 (Info) — Post-commit error-frame bytes: prior art is reason-accurate and `[DONE]`-terminated.** Verified against vLLM Rust `openai/chat_completions.rs` (`data: {"error":…}` then `data: [DONE]`), LocalAI `chat.go` (same), official Anthropic streaming doc (`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"…"}}` — RouteTok's anthropic branch already matches), and the OpenAI Responses `error` + `response.failed` pair (openai-node `ResponseErrorEvent`/`ResponseFailedEvent`). Recommendation: keep RouteTok's `stream_interrupted` envelope (clients keep working) but populate coarse reason sub-fields — `idle_timeout`/`deadline`/`reader_abort` — and append `data: [DONE]` for OpenAI-Chat (openai-node consumes `[DONE]` as a break; without it many downstream routers treat the drop as a mid-stream error). Anti-pattern: LiteLLM PR #20850 (traceback into SSE frame) — never leak internals into `message`. [N.B. the dedicated byte-shape cross-verifier returned empty; these recommendations rest on the fifth workstream's fetched sources plus the personal openai-node decoder read, not on a second independent pass.]

**N4-6 (Medium) — Half-open stampede fix pinned with precedent; wedge case added.** Verified primary sources: Hystrix `attemptExecution()` admits exactly ONE probe (CAS `OPEN→HALF_OPEN`, all other calls denied; `markNonSuccess()` CAS `HALF_OPEN→OPEN` — immediate re-open on one probe failure); Sentinel-golang `ProbeNum`: "if err occurs during the probe, the circuit breaker is opened immediately"; Resilience4j permits N=10 by default (count-until-threshold, not immediate re-open). Endorsed fix for `router.ts`, three insertion points: (a) in `candidates()` `:129-136`, flip to half-open only when `state.inflight === 0` (single probe; `inflight` already maintained at `:160-167` from `proxy.ts:1163,1484`, and the `final` pairing is balanced on all normal paths — try at `proxy.ts:1169` opens below `startAttempt` at `:1163`, so only a synchronous `updateInFlight` throw could skew, negligible); (b) `recordTransientFailure` `:169-187`: if `circuitState === "half-open"` → immediately set open + `circuitOpenUntil`, return (skip window accumulation); (c) `recordRateLimit` `:193-197` and `recordEntitlementFailure` `:199-203`: also re-open when half-open — pass-2/3 flagged that they never re-open; Hystrix/Sentinel treat any probe non-success as re-open, and without it a rate-limited/entitlement-blocked probe stays half-open forever (the `:127-128` flanks suppress candidates anyway, so re-opening is safe bookkeeping). Caveat surfaced by cross-ref: `route-simulator.ts:45` reads half-open as not-blocked post-cooldown and does **not** model the `inflight===0` gate — update the simulator in lockstep or it over-predicts probes. All `circuitState` consumers verified read-only (`route-simulator.ts:45`, `server.ts:413,423`, `metrics.ts:515`, `model-metadata.ts:49`).

**N4-7 (Info) — P2-P1 payload measured.** See delta row: `/admin/api/status` = 17,783 B with 11 fallback models under `catalog.models`; scales linearly with the live catalog. The DOS/embed concern stands for multi-thousand-model catalogs; revisioned/projected endpoint remains the fix.

**N4-8 (Info) — EXP repeat run corroboration.** A second EXP3 run with semantically-meaningful chunks every 500 ms committed at ~506 ms and then truncated at the 5 s deadline — an EXP2-style confirmation via a different path (status 200, terminal `stream_committed`, recorded "request deadline exceeded"). Converges both experiments on the same mechanism: the overall controller is never detached post-commit (`proxy.ts:1115-1117,1162`).

### Executive top-10 — changes from pass 3

1. P2-1 remains #1 and is **widened to the committed-stream truncation family** (flat frame + `response.failed` + no-terminal). Runtime-experimented (EXP1) and client-impact-verified (N4-1). Fix is small but now three-part (relay `type:"error"`, emit a frame on normal-exit-with-error, reason-accurate + `[DONE]`).
2. #2 (600 s deadline) moves to implementation-ready: idle-based post-commit governance is the industry standard, fix shape endorsed with a race guard (N4-2). Live-truncated at 5040 ms (EXP2).
3. #1 (half-open stampede) moves to implementation-ready: single-probe `inflight===0` gate + immediate re-open incl. rate-limit/entitlement probes + simulator parity (N4-6).
4. NEW, folds into #1: the truncation family is the most common real-world failure shape and is **invisible to every major SDK client** (N4-1/N4-4) — raises the value of the two above fixes.
5. No other top-10 changes; all prior rows carry.

### Appendix A updates (apply from this pass onward)

| Item | Change |
|---|---|
| 2.2 (deadline) | Fix shape endorsed: detach overall deadline at commit (`clearTimeout` in the synchronous commit path; keep client-close + idle as post-commit bounds); error frame made reason-accurate (`deadline` vs idle). Cite N4-2/EXP2. |
| 2.1 (half-open) | Fix pinned to `router.ts:129-136` (`inflight===0` gate) + `:169-187` (half-open immediate re-open) + `:193-203` (rate-limit/entitlement half-open re-open); add route-simulator lockstep. Cite N4-6. |
| P2-1 | Expanded to three-headed truncation family; fix now (a) relay at `proxy.ts:644`, (b) emit frame on normal-exit-with-error before `:1631`, (c) reason-accurate + `[DONE]` for chat. Cite N4-1/N4-4/N4-5. |
| P2-12 | UNCERTAIN cleared: mechanism pinned; one-line `break` fix in the prepareStream catch. Cite N4-3/EXP3. |
| P2-P1 | Payload measured: 17,783 B / 11 fallback models at `catalog.models`. Cite EXP4/N4-7. |

### Appendix B4 — pass-4 research sources (primary anchors)

- OpenAI Responses streaming-events (`error`, `response.failed`), openai-node `src/resources/responses/responses.ts` (`ResponseErrorEvent`), openai-node `src/core/streaming.ts` (throw-on-error, `[DONE]` break, no EOF sentinel), openai-python `src/openai/_streaming.py` (`[DONE]` break-only; `data.error` raise): developers.openai.com/api/reference/resources/responses/streaming-events ; raw.githubusercontent.com/openai/openai-node/master/src/core/streaming.ts ; raw.githubusercontent.com/openai/openai-python/main/src/openai/_streaming.py
- Real-world frequency: BerriAI/litellm#29223 (nested first-event error), #9296 (Groq empty delta), #15910 (commit-truncation discussion), #32086 (Kimi silent-empty Anthropic), #24608, PR #20850 (traceback leak), #31312; openai/codex#41989, #4302, #3924 (stream closed before response.completed); earendil-works/pi#6019 (mid-stream provider failure after committed function-call deltas); qwen-code#2402, cherry-chat/cherry-studio#13863, openclaw/openclaw#68120, pydantic-ai#2844 (OpenRouter `finish_reason:"error"`); vercel/ai#13506;#17500; openai-agents-python#3106; langchain#39039.
- Circuit breakers: Netflix/Hystrix `HystrixCircuitBreaker.java` (attemptExecution CAS single-probe; markNonSuccess re-open); alibaba/sentinel-golang `core/circuitbreaker/rule.go` (`ProbeNum` verbatim); resilience4j `CircuitBreakerConfig.java` (permittedNumberOfCallsInHalfOpenState=10); Envoy outlier/`request_timeout`-vs-streaming docs.
- Streaming timeouts: nginx `ngx_http_proxy_module#proxy_read_timeout` (per-read idle); Envoy timeouts FAQ (request_timeout incompatible with streaming; idle recommended); LiteLLM proxy timeout/error-reference docs + #29602 (committed-stream logged-as-success bug); vLLM Rust `chat_completions.rs` (error + `[DONE]`); LocalAI `chat.go`; Anthropic streaming doc (`event: error, overloaded_error`).
- WHATWG SSE, Node streams "Buffering" (highWaterMark not a hard cap), Instawork llm-proxy `scanner.Buffer(64KiB, 2 MiB)`.
- unverified issue-number citations (not fetched this pass) are limited to cross-ref recaps: Hystrix#1723, Sentinel#1638 — behavior confirmed from source, issue numbers secondary.

### Pass-4 caveats

- The post-commit error-frame cross-verifier (X-2) returned an empty result and was not re-dispatched (operator instruction); N4-5 therefore rests on the fifth workstream's fetched primary sources plus a personal openai-node decoder read, not on a second independent agent.
- Live experiments used a local mock upstream and the fallback-only catalog; real-provider byte-level Responses error-frame behavior (OpenRouter/Requesty/Kimi) was not live-captured (no outbound inference in the chain). Frequency estimates are issue-density heuristics.
- The `inflight===0` gate relies on `startAttempt`/`finishAttempt` pairing (`proxy.ts:1163` vs `:1484`); a synchronous throw between them (only `metrics.updateInFlight`) would skew the counter — negligible but flagged.
- `route-simulator.ts:45` divergence under the new half-open gate is a decided-but-unaddressed parity item.
- UNCERTAIN carried: prod `dashboards/` intent (operator call). All other pass-3 UNCERTAIN items are cleared (P2-12 empirically; P2-3 frequency assessed; P2-P1 bytes measured; undici propagation observed). B runs: P2-P1 DISPUTED-upgrade? No — supersedes completed.
- **Stop-rule consideration:** HEAD static across passes 1-4, but pass 4 produced material runtime findings (N4-1/2/3 with EXP1/2/3 live evidence) and pinned implementation-ready fix shapes. The chain should CONTINUE to pass 5 focused on: implementing the pinned fixes in the dev checkout (all zero-dependency), adding integration tests for the overall-deadline abort and half-open single-probe, and verifying the error-frame bytes against the isolated 8788 instance — not further re-auditing static code.
- No code modified; prod (8787) untouched; harnesses torn down.
