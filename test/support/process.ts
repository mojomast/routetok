import type { ChildProcess } from "node:child_process";

const PROVIDER_ENVIRONMENT_KEYS = [
  "AGENTROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "REQUESTY_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "KIMI_CODING_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "DEEPINFRA_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "GENERIC_OPENAI_API_KEY",
  "GENERIC_OPENAI_BASE_URL",
  "LOCAL_STT_BASE_URL",
  "LOCAL_STT_API_KEY"
] as const;

export function isolatedTestEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROVIDER_ENVIRONMENT_KEYS) environment[key] = "";
  return { ...environment, ...overrides };
}

export async function stopChild(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const onExit = () => {
      exited = true;
      resolve();
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      onExit();
    }
  });

  child.kill("SIGTERM");
  await Promise.race([exit, delay(timeoutMs, true)]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exit, delay(timeoutMs, true)]);
  }
  if (!exited) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}

export async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await delay(20);
    value = await read();
  }
  if (!accept(value)) throw new Error(`Condition was not met within ${timeoutMs}ms`);
  return value;
}

function delay(milliseconds: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (unref) timer.unref();
  });
}
