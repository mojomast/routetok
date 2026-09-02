# Contributing

1. Use Node.js 22 or newer.
2. Run `npm ci`.
3. Keep provider credentials only in ignored environment files.
4. Make the smallest correct change and preserve compatibility behavior.
5. Run `npm run typecheck`, `npm test`, and `npm run build`.
6. Update documentation and tests for public behavior changes.

Never include secrets, real request content, runtime telemetry, or raw provider reasoning in issues, fixtures, screenshots, or commits.
