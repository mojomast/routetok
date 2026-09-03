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

If local transcription is enabled, operate Speaches as a separate loopback-only service and preserve its model cache independently from RouteTok's `DATA_DIR`. The included `model-init` service retries transient HTTP/network failures and has a bounded on-failure restart policy; persistent failures remain visible through `docker compose ps` and logs.

## Docker Compose

The root `Dockerfile` builds RouteTok in a Node 22 multi-stage image. The runtime image contains only compiled server files and `public/`, runs as the unprivileged `node` user, uses a read-only root filesystem, drops Linux capabilities, and includes a `/healthz` health check.

Create `.env` as usual and set both access controls. The container listens on its private network, so `PROXY_API_KEY` is required even though Compose publishes the service only on host loopback by default.

```dotenv
PROXY_API_KEY=replace-with-a-client-key
DASHBOARD_TOKEN=replace-with-an-admin-token
```

Start RouteTok:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f routetok
```

Open `http://127.0.0.1:8787/dashboard` and verify `http://127.0.0.1:8787/healthz`.

Runtime state is stored in the `routetok-data` named volume mounted at `/app/data`. `docker compose down` preserves it. Do not use `docker compose down --volumes` unless you intend to delete routing configuration, metrics, stored provider credentials, and managed client-key hashes.

### Port Isolation

To run the container beside another RouteTok instance, choose another host port without changing the in-container port:

```bash
ROUTETOK_DOCKER_PORT=8790 docker compose up -d --build
```

You can also persist these Compose-only values in `.env`:

```dotenv
ROUTETOK_DOCKER_BIND=127.0.0.1
ROUTETOK_DOCKER_PORT=8790
```

### Local Providers

Inside a container, `127.0.0.1` refers to the RouteTok container rather than the host. Compose maps `host.docker.internal` to the host gateway on Linux, macOS, and Windows. Point separately managed local services there:

```dotenv
LOCAL_STT_BASE_URL=http://host.docker.internal:8000/v1
GENERIC_OPENAI_BASE_URL=http://host.docker.internal:8001/v1
GENERIC_OPENAI_ALLOW_PRIVATE=true
```

Only configure trusted local destinations. Keep their host ports bound to trusted interfaces and apply their own authentication where available.

### Upgrades And Backups

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
```

Back up the named volume before upgrades. To inspect its Docker-managed mount point without printing secret content, use `docker volume inspect routetok_routetok-data` (the Compose project prefix may differ).
