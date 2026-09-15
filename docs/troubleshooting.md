# Troubleshooting

## No models

Check provider key status, catalog errors, and base URLs in the dashboard. Unknown-price external models must be explicitly enabled.

## Model appears but fails

Catalog visibility does not guarantee provider entitlement or current capacity. Inspect the request attempt chain, HTTP status, first-output deadline, and provider-specific error.

## Local 400 has no selected route

If a `400` has `x-request-id` but no `x-router-model`, `x-router-route`, or `x-router-provider`, RouteTok rejected the request before routing. Validate handcrafted payloads with `jq` or another JSON parser; common mistakes include trailing commas, comments, unescaped quotes or newlines, and shell interpolation that produces invalid JSON. The top level must be an object, `model` must be a non-empty string, and `stream`, when present, must be boolean.

RouteTok intentionally does not locally validate tool schemas, `oneOf`, `enum`, or `tool_choice`. A rejection involving those fields after routing is provider behavior; inspect the selected-route headers and attempt summary.

## DeepSeek v4 structured output returns 400

The AgentRouter `deepseek-v4-*` adapter rejects both strict and non-strict `response_format: {"type": "json_schema", …}` with `400 This response_format type is unavailable now`, even with thinking disabled. For AgentRouter OpenAI Chat Completions attempts targeting `deepseek-v4-*`, RouteTok translates the request per attempt into a single appended function tool whose `parameters` is the caller's schema with `tool_choice: "auto"`, so the caller's thinking setting is preserved. The returned tool call is unwrapped back into `message.content` (or streamed `delta.content`) with `finish_reason: "stop"`; the client reads normal content JSON and never sees the synthetic tool.

Because the adapter rejects a forced `tool_choice` while thinking mode is active, the auto path is preferred. If the auto attempt produces no matching tool call and no usable JSON content — including a `finish_reason: "length"` answer where reasoning consumed the whole budget — RouteTok retries that attempt once with a forced tool and `thinking: { "type": "disabled" }` to guarantee the schema. Thinking-on structured calls therefore need a sufficient `max_tokens`; raise the budget rather than relying on the fallback.

`response_format: {"type": "json_object"}` is passed through unchanged and still requires the literal word "json" in the prompt, per the OpenAI-compatible contract. Any forced `tool_choice` (`"required"` or an explicit function) against `deepseek-v4-*` fails with `400 Thinking mode does not support this tool_choice` unless thinking is disabled; the `json_schema` translation disables thinking automatically on its fallback but does not override an explicit forced-tool request that omits thinking controls. Boolean `thinking: false`, `enable_thinking: false`, and `chat_template_kwargs.enable_thinking: false` are normalized to `thinking: { "type": "disabled" }`, and `reasoning_effort: "none"` is preserved, so clients can opt out of thinking for schema- or tool-constrained calls.
## Verify one exact Qwen attempt

Temporarily set `maxAttempts` to `1`, send a minimal non-stream Chat Completions request to the exact enabled `openrouter:` Qwen model ID, and omit tools and optional generation fields. Confirm `x-router-route` equals that ID, `x-router-provider` is `openrouter`, `x-router-attempts` is `1`, and `x-router-terminal` explains the terminal result. Decode `x-router-attempt-summary` with a base64url-aware decoder and verify its sole `a` entry (`p`, `m`, `s`, and `o`).

This isolates entitlement and upstream behavior from the paid fallback chain. Restore the previous `maxAttempts` afterward. Do not infer deployed Nex, DeepSeek, or Solar IDs from display names; exact catalog IDs remain operator-controlled.

## Streams time out

Reasoning models may need `slowModelFirstEventTimeoutMs`. Heartbeats and metadata do not satisfy the semantic-output deadline. A first-output timeout can try another candidate, but after semantic or tool output commits, a later timeout or disconnect ends that same stream without fallback. Committed-stream failures are not silent: RouteTok appends a protocol-shaped error frame (with a coarse `reason` sub-field such as `idle_timeout`, `deadline`, `reader_abort`, or `upstream_error`) before ending the response, and OpenAI-Chat streams also receive `data: [DONE]`. Inspect the reason in the terminal frame and the attempt outcome (`committed_failure`) in dashboard history rather than treating a truncated stream as a successful completion.

## Generic endpoint unavailable

Confirm the base URL points to the API root and serves `GET /models` plus `POST /chat/completions`. Local HTTP endpoints require `GENERIC_OPENAI_ALLOW_PRIVATE=true`; no-auth endpoints require `GENERIC_OPENAI_AUTH=none`.

## Dashboard authentication

Clear the saved dashboard token from browser site storage and reconnect. Credential management requires `DASHBOARD_TOKEN` even on loopback.

## Managed client key does not work

Confirm the application uses the complete one-time `rtk_…` secret as either `Authorization: Bearer <key>` or `x-api-key: <key>`. API Setup lists labels and IDs, not secret values. If the secret was lost, revoke that entry and create a replacement. The environment `PROXY_API_KEY` remains a separate accepted credential.

## Docker container exits during startup

Run `docker compose logs routetok`. Because the container listens on `0.0.0.0` internally, it requires `PROXY_API_KEY` or an existing managed client key in the persisted volume. New Docker deployments should set both `PROXY_API_KEY` and `DASHBOARD_TOKEN` in `.env` before startup.

## Docker cannot reach a local provider

Container loopback is isolated from host loopback. Replace host-local URLs such as `http://127.0.0.1:8000/v1` with `http://host.docker.internal:8000/v1`. The provided Compose file maps that hostname to the host gateway. Confirm the local service accepts connections from the Docker bridge and remains protected from untrusted networks.

## Dashboard assets are unavailable

The dashboard and Fieldbook URLs return `500` (or the process refuses to start with a list of missing allowlisted assets) when `public/` is incomplete: every file in the server's static allowlist must exist on disk. A partial deploy that copies only some frontend files produces exactly this mode — sync `public/index.html` together with the module files it references (`app.js`, `styles.css`, `theme-bootstrap.js`, `api-setup.js`, `attempt-inspector.js`, `onboarding.js`, `sandbox.js`/`sandbox.css`, and the `fieldbook/*.js` modules), never individually. `node scripts/smoke.mjs` boots the service and GETs every allowlisted route so this can be checked before a deploy.

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
