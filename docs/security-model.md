# Security Model

RouteTok is designed for a trusted single-user host and defaults to loopback.

## Boundaries

- Set both `PROXY_API_KEY` and `DASHBOARD_TOKEN` before network exposure.
- Provider keys are replaced server-side and never accepted from inference callers.
- Dashboard key ingress is write-only and persists plaintext under owner-only permissions.
- Base URL environment overrides are trusted operator configuration and can exfiltrate provider credentials if malicious.
- The generic endpoint remains startup-only; private HTTP access requires explicit opt-in.
- Catalog and inference redirects are blocked.
- Model-generated Markdown is escaped before rendering.
- Design previews use opaque sandboxed iframes, dashboard-owned CSP, no scripts, and no external navigation/resources.

## Retention

Server metrics persist request metadata, errors, timing, tokens, and costs. Eligible request bodies may be retained only in bounded process memory for authenticated inspection. Sandbox content persists in browser IndexedDB. The dashboard token persists in local storage.

Filesystem permissions do not protect against root, same-UID compromise, process compromise, backups, swap, or an unencrypted disk. Use full-disk encryption or an external secret manager where those threats matter.
