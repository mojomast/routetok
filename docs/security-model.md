# Security Model

RouteTok is designed for a trusted single-user host and defaults to loopback.

## Boundaries

- Set both `PROXY_API_KEY` and `DASHBOARD_TOKEN` before network exposure.
- The no-credential fallback binds service surfaces to loopback connections and additionally rejects cross-origin browser requests: while a service credential is unset, `GET /v1/models`, `/v1` inference POSTs, `/admin/api/*`, and `GET /metrics` answer `403` to any `Origin` header that is not the loopback service's own origin, so web pages from other origins cannot read or drive the fallback surface. With credentials configured the `Origin` header is ignored and key checks govern.
- Provider keys are replaced server-side and never accepted from inference callers.
- Managed proxy client keys are generated with high entropy, shown once, and persisted only as SHA-256 digests. Individual revocation is immediate.
- Dashboard key ingress is write-only and persists plaintext under owner-only permissions.
- OAuth tokens and refresh tokens are stored write-only under `DATA_DIR/secrets/provider-oauth.json`. Connection management requires `DASHBOARD_TOKEN`, no token material is returned to the browser, and the Codex browser callback listener binds to loopback, validates `state`, serves static HTML, and closes on completion or timeout.
- Base URL environment overrides are trusted operator configuration and can exfiltrate provider credentials if malicious.
- The generic endpoint remains startup-only; private HTTP access requires explicit opt-in (`GENERIC_OPENAI_ALLOW_PRIVATE=true`), and with the opt-in set the configured host must resolve exclusively to private addresses at startup (RFC 1918, loopback, link-local, CGNAT, ULA, or multicast); unresolvable or public-resolving names prevent startup. HTTPS base URLs without the opt-in remain trusted operator configuration.
- Catalog and inference redirects are blocked.
- Model-generated Markdown is rendered through bounded safe DOM construction.
- Generated HTML, SVG, design, and Studio previews use opaque sandboxed iframes with network access blocked. Provider-returned SVG is additionally structure-checked before it is handed to the renderer: processing instructions (`xml-stylesheet`), `style` elements and CSS `@import`, executable or embedded elements (`script`, `foreignObject`, `iframe`, `object`, `embed`), event-handler attributes, `DOCTYPE`/`ENTITY`, and any non-fragment `href`/`src`/`xlink:href` on `a`, `image`, `use`, and `feImage` (including `javascript:` and `data:` values) are rejected, while internal `#fragment` references and `url(#...)` paint references remain allowed.
- Studio JavaScript is opt-in and runs without same-origin access; virtual projects cannot read repository or filesystem files.
- Fieldbook context is explicit, one-shot, size-bounded, provenance-labelled, and treated as untrusted model data.
- Studio patches and image requests are scope/revision checked. Image generation requires approval before the provider call.
- Native Chat tools execute only in the browser: reads act on catalog state and note-local IndexedDB content, and writes are approval-gated and never touch the filesystem or the network beyond the existing approval-gated image endpoint. The server never executes tools; it only validates bounded declarations and relays normalized tool calls back to the client.
- Fieldbook Chat tool declarations are capped at 16 validated tools with bounded schemas, transcripts are capped at 40 messages and 500,000 characters, and tool loops stop at 8 tool turns, a final answer, or user abort.

## Retention

Server metrics persist request metadata, errors, timing, tokens, and costs. Eligible request bodies may be retained only in bounded process memory for authenticated inspection, expire after 24 hours, and are evicted when new content is retained; setting `ROUTETOK_RETAIN_REQUEST_CONTENT=0` disables retention entirely. Dashboard and Fieldbook content persist in separate browser IndexedDB databases. The dashboard token persists in local storage.

Generated image bytes, recordings, speech output, filenames, and unreviewed transcripts remain ephemeral. They are excluded from metrics, history, retained requests, Fieldbook notes, IndexedDB, and exports.

Filesystem permissions do not protect against root, same-UID compromise, process compromise, backups, swap, or an unencrypted disk. Use full-disk encryption or an external secret manager where those threats matter.

The provided Docker deployment runs as a non-root user, drops capabilities, prevents privilege escalation, and uses a read-only root filesystem with only `/app/data` and a bounded `/tmp` writable. Compose loads `.env` at runtime; Docker build context rules exclude environment files and runtime data from the image.
