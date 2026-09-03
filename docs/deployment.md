# Deployment

Build and run RouteTok from a fixed working directory so `public/` remains available:

```bash
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm start
```

Use a process supervisor such as systemd, Docker, or your platform's service manager. Preserve `DATA_DIR` across upgrades and back it up as sensitive operational data. It may contain write-only provider credentials and hashes for managed proxy client keys.

For remote access, terminate TLS at a trusted reverse proxy or private overlay network. Keep RouteTok bound to loopback, require both service tokens, restrict source networks, and do not expose `DATA_DIR` or environment files.

Upgrade procedure:

1. Back up `DATA_DIR`.
2. Install dependencies with `npm ci`.
3. Run typecheck/tests/build.
4. Restart the process.
5. Verify `/healthz`, `/v1/models`, `/dashboard`, and `/sandbox`.

Keep the complete `public/` directory beside the built service. The Fieldbook imports explicitly routed modules from `public/fieldbook/`, and the optional static benchmark gallery uses `public/image-gallery/`.

If local transcription is enabled, operate Speaches as a separate loopback-only service and preserve its model cache independently from RouteTok's `DATA_DIR`.
