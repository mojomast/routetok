# Security Model

RouteTok is designed for a trusted single-user host and defaults to loopback.

## Boundaries

- Set both `PROXY_API_KEY` and `DASHBOARD_TOKEN` before network exposure.
- Provider keys are replaced server-side and never accepted from inference callers.
- Managed proxy client keys are generated with high entropy, shown once, and persisted only as SHA-256 digests. Individual revocation is immediate.
- Dashboard key ingress is write-only and persists plaintext under owner-only permissions.
- Base URL environment overrides are trusted operator configuration and can exfiltrate provider credentials if malicious.
- The generic endpoint remains startup-only; private HTTP access requires explicit opt-in.
- Catalog and inference redirects are blocked.
- Model-generated Markdown is rendered through bounded safe DOM construction.
- Generated HTML, SVG, design, and Studio previews use opaque sandboxed iframes with network access blocked.
- Studio JavaScript is opt-in and runs without same-origin access; virtual projects cannot read repository or filesystem files.
- Fieldbook context is explicit, one-shot, size-bounded, provenance-labelled, and treated as untrusted model data.
- Studio patches and image requests are scope/revision checked. Image generation requires approval before the provider call.

## Retention

Server metrics persist request metadata, errors, timing, tokens, and costs. Eligible request bodies may be retained only in bounded process memory for authenticated inspection. Dashboard and Fieldbook content persist in separate browser IndexedDB databases. The dashboard token persists in local storage.

Generated image bytes, recordings, speech output, filenames, and unreviewed transcripts remain ephemeral. They are excluded from metrics, history, retained requests, Fieldbook notes, IndexedDB, and exports.

Filesystem permissions do not protect against root, same-UID compromise, process compromise, backups, swap, or an unencrypted disk. Use full-disk encryption or an external secret manager where those threats matter.
