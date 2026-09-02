# Deployment

Build and run RouteTok from a fixed working directory so `public/` remains available:

```bash
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm start
```

Use a process supervisor such as systemd, Docker, or your platform's service manager. Preserve `DATA_DIR` across upgrades and back it up as sensitive operational data.

For remote access, terminate TLS at a trusted reverse proxy or private overlay network. Keep RouteTok bound to loopback, require both service tokens, restrict source networks, and do not expose `DATA_DIR` or environment files.

Upgrade procedure:

1. Back up `DATA_DIR`.
2. Install dependencies with `npm ci`.
3. Run typecheck/tests/build.
4. Restart the process.
5. Verify `/healthz`, `/v1/models`, and dashboard status.
