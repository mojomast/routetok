# Architecture

RouteTok is a single Node.js process with four core backend layers:

1. `CatalogService` discovers and normalizes provider models into namespaced route IDs.
2. `HealthRouter` applies configuration, enablement, circuits, rate limits, and route ordering.
3. `ProxyHandler` replaces credentials, dispatches attempts, validates streams, and records usage.
4. `MetricsStore` persists bounded metadata/history and exposes live/Prometheus views.

Clients call OpenAI or Anthropic-compatible endpoints. RouteTok resolves a virtual or physical route, filters endpoint-compatible candidates, and attempts models sequentially until output begins. Transport failures, first-output failures, and configured transient statuses can move to the next candidate only before semantic or tool output. A complete successful response and a stream committed by text, reasoning, refusal, or tool/function output never move to another model; later stream failure remains on that committed stream.

Explicit paid OpenRouter requests have a dedicated provider-tiered fallback path. The requested model remains first, configured paid OpenRouter alternatives retain their exact order, and only then may compatible AgentRouter models from the protocol order be used. Health suppression may remove a candidate but cannot move AgentRouter ahead of a healthy configured OpenRouter alternative. Other request classes retain their existing protocol, free, explicit, or custom-cascade behavior.

The intended Qwen policy is conceptually requested Qwen -> Nex N2 Mini -> OpenRouter DeepSeek V4 Flash -> Solar Pro 4 -> AgentRouter. It is not a hard-coded route mapping: operators select and enable the exact deployed `openrouter:` IDs, while catalog availability, compatibility, health, and `maxAttempts` still apply.

Each attempt receives the original request fields with only the physical `model` substituted. Anthropic Messages retains its thinking pin/strip and AgentRouter DeepSeek historical-tool compatibility transformations; OpenAI Chat Completions does not apply those transformations. Terminal routing headers identify the selected route and expose only a bounded base64url attempt projection of model, provider, status, and outcome.

## Product Surfaces

- **Proxy:** OpenAI- and Anthropic-compatible inference endpoints under `/v1`.
- **Dashboard:** the operational control plane at `/dashboard`, backed by authenticated `/admin/api/*` resources.
- **Model Fieldbook:** the standalone experimentation application at `/sandbox`, with separate frontend assets and browser storage.

The dashboard and Fieldbook share server-side catalogs and bounded inference/media APIs but do not share application bundles or IndexedDB databases. Static Fieldbook ES modules and image-gallery assets are exposed through explicit route allowlists rather than a general-purpose static directory.

Provider catalogs, credits, routing configuration, metrics, dashboard content, and browser sandbox history have separate storage boundaries. Provider credentials never enter `RouterConfig` or metrics.

## Metadata Projection

`CatalogService` preserves normalized values together with catalog, curated, and pricing provenance instead of filling gaps by inference. The opt-in proxy model list uses metadata schema version 1. Admin status retains the broader raw operational model records, while the sandbox and image catalogs expose corresponding normalized camel-case fields for their narrower eligible model sets.

The default `/v1/models` serializer is a separate strict-compatibility path and remains unchanged. Only `include=routetok` adds the nested per-entry projection; unknown include modes fail with `400`. In the enriched projection, `null` is unknown, `[]` is known empty, and zero is a real value. Pricing retains explicit currency, unit, source, decimal-string rates, and token-count tier thresholds rather than collapsing missing values into zero.

Metadata for virtual routes and custom cascades is aggregated conservatively. Identity, route kind, members, and configured ranks can be stated directly, but candidate-dependent limits, modalities, capabilities, supported parameters, pricing, and health remain unknown. Physical health is exposed only as a bounded, protocol-specific safe projection, never as raw circuit errors or sensitive request data.

## State

- `DATA_DIR/config.json`: routing policy, mode `0600`
- `DATA_DIR/metrics.json`: bounded usage metadata/history, mode `0600`
- `DATA_DIR/secrets/provider-credentials.json`: optional write-only overrides, directory `0700`, file `0600`
- `DATA_DIR/secrets/client-api-keys.json`: hashes and metadata for managed proxy client keys, mode `0600`
- Dashboard browser storage: Support workspace preferences and local drafts
- Fieldbook IndexedDB: saved notes, comparisons, rooms, evaluations, and Studio projects
- Fieldbook IndexedDB: notes, text results, evaluations, Room state, scratchpad revisions, and virtual Studio projects
- Process memory: health circuits, catalogs, credits cache, in-flight requests, bounded request-content inspection

Audio and image bytes remain ephemeral and are excluded from persisted metrics, retained request bodies, browser notes, and exports.

## Runtime Packaging

Native and Docker deployments run the same compiled `dist/src/server.js` and static `public/` assets. The Docker image builds TypeScript in a separate stage, then runs only the compiled server and frontend as an unprivileged user. `/app/data` is the sole persistent writable application path; `/tmp` is an ephemeral bounded `tmpfs`, and the remaining container filesystem is read-only.

## Compatibility

AgentRouter is one provider with legacy bare model aliases. All additional providers use `<provider>:<upstream-id>` canonical routes. Public `x-router-*` headers report the selected physical route.
