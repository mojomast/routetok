# Architecture

RouteTok is a single Node.js process with four core layers:

1. `CatalogService` discovers and normalizes provider models into namespaced route IDs.
2. `HealthRouter` applies configuration, enablement, circuits, rate limits, and route ordering.
3. `ProxyHandler` replaces credentials, dispatches attempts, validates streams, and records usage.
4. `MetricsStore` persists bounded metadata/history and exposes live/Prometheus views.

Clients call OpenAI or Anthropic-compatible endpoints. RouteTok resolves a virtual or physical route, filters endpoint-compatible candidates, and attempts models sequentially until output begins. After semantic output is committed, no cross-model fallback is allowed.

Provider catalogs, credits, routing configuration, metrics, dashboard content, and browser sandbox history have separate storage boundaries. Provider credentials never enter `RouterConfig` or metrics.

## State

- `DATA_DIR/config.json`: routing policy, mode `0600`
- `DATA_DIR/metrics.json`: bounded usage metadata/history, mode `0600`
- `DATA_DIR/secrets/provider-credentials.json`: optional write-only overrides, directory `0700`, file `0600`
- Browser IndexedDB: saved sandbox prompts/results/designs
- Process memory: health circuits, catalogs, credits cache, in-flight requests, bounded request-content inspection

## Compatibility

AgentRouter is one provider with legacy bare model aliases. All additional providers use `<provider>:<upstream-id>` canonical routes. Public `x-router-*` headers report the selected physical route.
