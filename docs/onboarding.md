# Onboarding

The dashboard loads `window.Onboarding` from `/onboarding.js`. The wizard runs five read-only steps in order: key status, catalog, free model, test prompt, and success.

It checks `GET /admin/api/readiness`, `GET /admin/api/status`, and `GET /admin/api/sandbox/catalog`, then links each failing step to [Troubleshooting](troubleshooting.md). It never writes configuration; the test prompt (`Reply with OK`) is copied manually into the Fieldbook and confirmed by the operator.

Fieldbook notes can be exported and merged with `window.FieldbookBackup` from `/fieldbook/backup.js`. Bundles exclude secrets and ephemeral media, and cross-origin imports show an origin warning before merge. See [Troubleshooting](troubleshooting.md#fieldbook-state-looks-stale) before clearing site storage.
