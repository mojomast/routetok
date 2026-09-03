import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RouterConfig } from "./types.js";

export const DEFAULT_CONFIG: RouterConfig = {
  maxAttempts: 4,
  fallbackExplicitModels: true,
  thinkingFallbackMode: "strip",
  requestTimeoutMs: 600_000,
  firstEventTimeoutMs: 20_000,
  slowModelFirstEventTimeoutMs: 45_000,
  streamIdleTimeoutMs: 180_000,
  catalogRefreshHours: 6,
  circuitFailureThreshold: 3,
  circuitMinimumSamples: 5,
  circuitWindowSize: 10,
  circuitOpenMs: 30_000,
  openaiOrder: [
    "gpt-5.6-sol",
    "claude-opus-5",
    "claude-opus-4-8",
    "glm-5.3",
    "deepseek-v4-flash"
  ],
  anthropicOrder: [
    "claude-opus-5",
    "claude-opus-4-8",
    "glm-5.3",
    "deepseek-v4-flash"
  ],
  paidOpenRouterFallbackOrder: [],
  disabledModels: [],
  enabledExternalModels: [
    "kimi:k3",
    "kimi:k3-256k",
    "kimi:kimi-for-coding",
    "kimi:kimi-for-coding-highspeed"
  ],
  freeModelOrder: [
    "openrouter:minimax/minimax-m3:free",
    "opencode:nemotron-3-ultra-free",
    "opencode:nemotron-3.5-lightning-free",
    "openrouter:openrouter/free"
  ],
  dashboardModel: "deepseek-v4-flash"
  ,customCascades: []
};

const NUMBER_LIMITS: Record<
  keyof Pick<
    RouterConfig,
    | "maxAttempts"
    | "requestTimeoutMs"
    | "firstEventTimeoutMs"
    | "slowModelFirstEventTimeoutMs"
    | "streamIdleTimeoutMs"
    | "catalogRefreshHours"
    | "circuitFailureThreshold"
    | "circuitMinimumSamples"
    | "circuitWindowSize"
    | "circuitOpenMs"
  >,
  [number, number]
> = {
  maxAttempts: [1, 5],
  requestTimeoutMs: [5_000, 600_000],
  firstEventTimeoutMs: [1_000, 120_000],
  slowModelFirstEventTimeoutMs: [5_000, 180_000],
  streamIdleTimeoutMs: [5_000, 300_000],
  catalogRefreshHours: [1, 168],
  circuitFailureThreshold: [1, 20],
  circuitMinimumSamples: [1, 100],
  circuitWindowSize: [2, 200],
  circuitOpenMs: [1_000, 3_600_000]
};

const CONFIG_FIELDS = new Set<keyof RouterConfig>([
  ...Object.keys(NUMBER_LIMITS) as Array<keyof RouterConfig>,
  "fallbackExplicitModels",
  "thinkingFallbackMode",
  "openaiOrder",
  "anthropicOrder",
  "paidOpenRouterFallbackOrder",
  "disabledModels",
  "enabledExternalModels",
  "freeModelOrder",
  "dashboardModel"
  ,"customCascades"
]);

export function configRevision(value: RouterConfig): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of model names`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

const RESERVED_CASCADE_NAMES = new Set(["auto", "best", "agentrouter-auto", "agentrouter-best", "free", "free-auto"]);
function customCascades(value: unknown): RouterConfig["customCascades"] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("customCascades must be an array with at most 32 queues");
  const cascades = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "name" && key !== "members")) throw new Error(`customCascades[${index}] is invalid`);
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate.name) || RESERVED_CASCADE_NAMES.has(candidate.name)) throw new Error(`Invalid custom cascade name at index ${index}`);
    if (!Array.isArray(candidate.members) || candidate.members.length === 0 || candidate.members.length > 64 || candidate.members.some((member) => typeof member !== "string" || !member.trim())) throw new Error(`${candidate.name} must contain 1 to 64 model IDs`);
    const members = candidate.members.map((member) => String(member).trim());
    if (new Set(members).size !== members.length || members.includes(candidate.name)) throw new Error(`${candidate.name} contains duplicate or recursive members`);
    return { name: candidate.name, members };
  });
  const names = cascades.map((cascade) => cascade.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("Custom cascade names must be unique");
  const nameSet = new Set(cascades.map((cascade) => cascade.name));
  if (cascades.some((cascade) => cascade.members.some((member) => nameSet.has(member)))) throw new Error("Custom cascades cannot contain other custom cascades");
  return cascades;
}

export class ConfigStore {
  private config: RouterConfig = structuredClone(DEFAULT_CONFIG);
  private readonly filePath: string;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "config.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.config = this.validate(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Ignoring invalid persisted configuration:", (error as Error).message);
      }
    }
  }

  get(): RouterConfig {
    return structuredClone(this.config);
  }

  revision(): string {
    return configRevision(this.config);
  }

  preview(input: unknown, base: RouterConfig = this.config): RouterConfig {
    return this.validate(input, base);
  }

  async update(input: unknown): Promise<RouterConfig> {
    const operation = this.updateQueue.then(async () => {
      const next = this.validate(input, this.config);
      await this.persist(next);
      this.config = next;
      return this.get();
    });
    this.updateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async updateIfRevision(input: unknown, expectedRevision: string): Promise<RouterConfig> {
    const operation = this.updateQueue.then(async () => {
      if (configRevision(this.config) !== expectedRevision) {
        throw new Error("Configuration changed after this proposal was reviewed");
      }
      const next = this.validate(input, this.config);
      await this.persist(next);
      this.config = next;
      return this.get();
    });
    this.updateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private validate(input: unknown, base: RouterConfig = DEFAULT_CONFIG): RouterConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Configuration must be an object");
    }

    const value = input as Record<string, unknown>;
    const unknown = Object.keys(value).filter((field) => !CONFIG_FIELDS.has(field as keyof RouterConfig));
    if (unknown.length) throw new Error(`Unknown configuration field: ${unknown.join(", ")}`);
    const next = structuredClone(base);

    for (const [field, limits] of Object.entries(NUMBER_LIMITS)) {
      if (value[field] === undefined) continue;
      const number = value[field];
      if (typeof number !== "number" || !Number.isInteger(number)) {
        throw new Error(`${field} must be an integer`);
      }
      if (number < limits[0] || number > limits[1]) {
        throw new Error(`${field} must be between ${limits[0]} and ${limits[1]}`);
      }
      (next as unknown as Record<string, unknown>)[field] = number;
    }

    if (value.fallbackExplicitModels !== undefined) {
      if (typeof value.fallbackExplicitModels !== "boolean") {
        throw new Error("fallbackExplicitModels must be a boolean");
      }
      next.fallbackExplicitModels = value.fallbackExplicitModels;
    }
    if (value.thinkingFallbackMode !== undefined) {
      if (value.thinkingFallbackMode !== "pin" && value.thinkingFallbackMode !== "strip") {
        throw new Error("thinkingFallbackMode must be pin or strip");
      }
      next.thinkingFallbackMode = value.thinkingFallbackMode;
    }

    if (value.openaiOrder !== undefined) {
      next.openaiOrder = uniqueStrings(value.openaiOrder, "openaiOrder");
    }
    if (value.anthropicOrder !== undefined) {
      next.anthropicOrder = uniqueStrings(value.anthropicOrder, "anthropicOrder");
    }
    if (value.paidOpenRouterFallbackOrder !== undefined) {
      const order = uniqueStrings(value.paidOpenRouterFallbackOrder, "paidOpenRouterFallbackOrder");
      if (order.some((model) => !model.startsWith("openrouter:"))) throw new Error("paidOpenRouterFallbackOrder must contain only namespaced OpenRouter model IDs");
      next.paidOpenRouterFallbackOrder = order;
    }
    if (value.disabledModels !== undefined) {
      next.disabledModels = uniqueStrings(value.disabledModels, "disabledModels");
    }
    if (value.enabledExternalModels !== undefined) {
      next.enabledExternalModels = uniqueStrings(value.enabledExternalModels, "enabledExternalModels");
    }
    if (value.freeModelOrder !== undefined) {
      next.freeModelOrder = uniqueStrings(value.freeModelOrder, "freeModelOrder");
    }
    if (value.dashboardModel !== undefined) {
      if (typeof value.dashboardModel !== "string" || !value.dashboardModel.trim()) {
        throw new Error("dashboardModel must be a non-empty model name");
      }
      next.dashboardModel = value.dashboardModel.trim();
    }
    if (value.customCascades !== undefined) next.customCascades = customCascades(value.customCascades);

    if (next.circuitMinimumSamples > next.circuitWindowSize) {
      throw new Error("circuitMinimumSamples cannot exceed circuitWindowSize");
    }
    return next;
  }

  private async persist(config: RouterConfig): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
