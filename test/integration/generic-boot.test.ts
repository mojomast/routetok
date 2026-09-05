import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedTestEnv } from "../support/process.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function bootFailure(env: NodeJS.ProcessEnv): Promise<{ code: number | null; message: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-generic-boot-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({ HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, ...env })
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  await rm(dataDir, { recursive: true, force: true });
  return { code, message: output.trim().split("\n")[0] ?? "" };
}

test("GENERIC_OPENAI_ALLOW_PRIVATE=true rejects base URLs that do not resolve to private addresses", async () => {
  for (const baseUrl of ["http://8.8.8.8/v1", "http://1.1.1.1/api", "http://example.test/v1"]) {
    const result = await bootFailure({ GENERIC_OPENAI_ALLOW_PRIVATE: "true", GENERIC_OPENAI_BASE_URL: baseUrl, GENERIC_OPENAI_AUTH: "none" });
    assert.notEqual(result.code, 0, `${baseUrl} must fail startup`);
    assert.match(result.message, /must resolve exclusively to private addresses/, `${baseUrl} must report the private-resolution gate`);
  }
});

test("private generic base URLs boot cleanly under the private flag", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "router-generic-boot-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedTestEnv({
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      GENERIC_OPENAI_ALLOW_PRIVATE: "true",
      GENERIC_OPENAI_BASE_URL: "http://localhost:1/v1",
      GENERIC_OPENAI_AUTH: "none"
    })
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup did not listen: ${output}`)), 10_000);
    const check = () => {
      if (output.includes("RouteTok listening")) { clearTimeout(timer); resolve(); }
    };
    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
  });
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});
