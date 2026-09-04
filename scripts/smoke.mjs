// RouteTok boot smoke: boots the server against a throwaway data dir with blanked
// provider keys and GETs every allowlisted static module plus /healthz.
// Usage: node scripts/smoke.mjs   (uses dist/src/server.js after `npm run build`,
// or src/server.ts via tsx when the build output is absent; probes a running
// instance when SMOKE_BASE_URL is set).
//
// The path list mirrors the staticFiles allowlist in src/server.ts. The
// authoritative guard against allowlist-vs-disk drift is the boot-time
// verification in src/server.ts (the server refuses to start when an allowlisted
// file is missing); this script is the CI-visible HTTP smoke on top of it.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const allowlistedPaths = [
  "/", "/dashboard", "/sandbox", "/sandbox/", "/sandbox.js", "/sandbox.css",
  "/fieldbook/panels.js", "/fieldbook/context-broker.js", "/fieldbook/studio-chat.js",
  "/fieldbook/image-approvals.js", "/fieldbook/tools.js", "/fieldbook/agent-loop.js",
  "/fieldbook/tool-approvals.js", "/fieldbook/backup.js", "/image-gallery",
  "/image-gallery/", "/image-gallery/gallery.css", "/app.js", "/attempt-inspector.js",
  "/api-setup.js", "/onboarding.js", "/theme-bootstrap.js", "/styles.css"
];

const PROVIDER_ENVIRONMENT_KEYS = [
  "AGENTROUTER_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY",
  "REQUESTY_API_KEY", "OPENCODE_ZEN_API_KEY", "KIMI_CODING_API_KEY", "GROQ_API_KEY",
  "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "DEEPINFRA_API_KEY", "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY", "GENERIC_OPENAI_API_KEY", "GENERIC_OPENAI_BASE_URL",
  "LOCAL_STT_BASE_URL", "LOCAL_STT_API_KEY"
];

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function boot() {
  const distEntry = path.resolve("dist/src/server.js");
  const executable = (await import("node:fs")).existsSync(distEntry)
    ? { command: process.execPath, args: [distEntry], note: "dist" }
    : { command: process.execPath, args: ["--import", "tsx", "src/server.ts"], note: "tsx src" };
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "routetok-smoke-"));
  const environment = { ...process.env };
  for (const key of PROVIDER_ENVIRONMENT_KEYS) environment[key] = "";
  const child = spawn(executable.command, executable.args, {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...environment, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, DASHBOARD_TOKEN: "" }
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (!output.includes("RouteTok listening")) {
    if (child.exitCode !== null) throw new Error(`smoke server exited early (${executable.note}):\n${output}`);
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`smoke server did not become ready:\n${output}`); }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, base: `http://127.0.0.1:${port}`, dataDir, note: executable.note };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => setTimeout(resolve, 200)); }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

let child = null;
let dataDir = null;
try {
  const preconfigured = process.env.SMOKE_BASE_URL?.trim();
  let base;
  if (preconfigured) {
    base = preconfigured;
  } else {
    const instance = await boot();
    child = instance.child;
    dataDir = instance.dataDir;
    base = instance.base;
  }
  const failures = [];
  const health = await fetch(`${base}/healthz`);
  if (health.status !== 200) failures.push(`GET /healthz -> ${health.status}`);
  else {
    const body = await health.json();
    if (body.status !== "ok" || Object.keys(body).length !== 1) failures.push("GET /healthz body is not minimal liveness");
  }
  for (const route of allowlistedPaths) {
    const response = await fetch(`${base}${route}`);
    if (response.status !== 200) failures.push(`GET ${route} -> ${response.status}`);
  }
  if (failures.length) {
    console.error(`smoke failed (${child ? "child" : "SMOKE_BASE_URL"}):\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`smoke ok: ${allowlistedPaths.length + 1} routes served (${child ? "booted child" : preconfigured})`);
  }
} catch (error) {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (child) await stop(child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
