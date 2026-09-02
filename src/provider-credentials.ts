import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderId, ProviderRuntime } from "./types.js";

type CredentialField = "apiKey" | "managementKey";
type CredentialValue = string | null;
type ProviderOverrides = Partial<Record<CredentialField, CredentialValue>>;
interface PersistedCredentials { version: 1; providers: Partial<Record<ProviderId, ProviderOverrides>> }

const FIELDS: Record<ProviderId, CredentialField[]> = {
  agentrouter: ["apiKey"], openrouter: ["apiKey", "managementKey"], requesty: ["apiKey"], opencode: ["apiKey"], kimi: ["apiKey"],
  groq: ["apiKey"], together: ["apiKey"], fireworks: ["apiKey"], deepinfra: ["apiKey"], cerebras: ["apiKey"], mistral: ["apiKey"], generic: ["apiKey"]
};

export interface CredentialStatus {
  providerId: ProviderId;
  configured: boolean;
  credentials: Partial<Record<CredentialField, { configured: boolean; source: "stored" | "environment" | "default" | "disabled" | "unset" }>>;
}

export class ProviderCredentialStore {
  private state: PersistedCredentials = { version: 1, providers: {} };
  private queue: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly filePath: string;

  constructor(
    dataDir: string,
    private readonly providers: ProviderRuntime[],
    private readonly baseline: Partial<Record<ProviderId, ProviderOverrides>>
  ) {
    this.directory = path.join(dataDir, "secrets");
    this.filePath = path.join(this.directory, "provider-credentials.json");
  }

  async load(): Promise<void> {
    try {
      this.state = this.validate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not load provider credentials: ${(error as Error).message}`);
    }
    for (const provider of this.providers) this.apply(provider.id);
  }

  status(providerId?: ProviderId): CredentialStatus[] {
    return this.providers.filter((provider) => !providerId || provider.id === providerId).map((provider) => ({
      providerId: provider.id,
      configured: provider.configured,
      credentials: Object.fromEntries(FIELDS[provider.id].map((field) => [field, this.fieldStatus(provider.id, field)]))
    }));
  }

  async update(providerId: ProviderId, field: CredentialField, input: unknown): Promise<CredentialStatus> {
    this.assertField(providerId, field);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !("value" in input)) throw new Error("Credential body must contain only value");
    const value = (input as { value?: unknown }).value;
    if (typeof value !== "string" || !value.trim()) throw new Error("Credential value must be a non-empty string");
    if (value.length > 16_384 || /[\0-\x1f\x7f]/.test(value)) throw new Error("Credential value is invalid");
    return this.mutate(providerId, field, value.trim());
  }

  async remove(providerId: ProviderId, field: CredentialField): Promise<CredentialStatus> {
    this.assertField(providerId, field);
    return this.mutate(providerId, field, null);
  }

  private async mutate(providerId: ProviderId, field: CredentialField, value: CredentialValue): Promise<CredentialStatus> {
    let result!: CredentialStatus;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      (next.providers[providerId] ??= {})[field] = value;
      await this.persist(next);
      this.state = next;
      this.apply(providerId);
      result = this.status(providerId)[0]!;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private apply(providerId: ProviderId): void {
    const provider = this.providers.find((entry) => entry.id === providerId)!;
    const apiKey = this.effective(providerId, "apiKey");
    provider.apiKey = apiKey ?? "";
    provider.configured = providerId === "opencode" ? true : providerId === "generic" && provider.auth === "none" ? Boolean(provider.baseUrl) : Boolean(apiKey);
    if (providerId === "openrouter") {
      const managementKey = this.effective(providerId, "managementKey");
      if (managementKey) provider.managementKey = managementKey;
      else delete provider.managementKey;
    }
  }

  private effective(providerId: ProviderId, field: CredentialField): string | null {
    const stored = this.state.providers[providerId];
    if (stored && Object.prototype.hasOwnProperty.call(stored, field)) {
      const value = stored[field];
      if (value === null) return providerId === "opencode" && field === "apiKey" ? "public" : null;
      return value ?? null;
    }
    return this.baseline[providerId]?.[field] ?? (providerId === "opencode" && field === "apiKey" ? "public" : null);
  }

  private fieldStatus(providerId: ProviderId, field: CredentialField) {
    const stored = this.state.providers[providerId];
    if (stored && Object.prototype.hasOwnProperty.call(stored, field)) {
      if (stored[field] === null) return providerId === "opencode" ? { configured: true, source: "default" as const } : { configured: false, source: "disabled" as const };
      return { configured: true, source: "stored" as const };
    }
    if (this.baseline[providerId]?.[field]) return { configured: true, source: "environment" as const };
    if (providerId === "opencode" && field === "apiKey") return { configured: true, source: "default" as const };
    return { configured: false, source: "unset" as const };
  }

  private assertField(providerId: ProviderId, field: CredentialField): void {
    if (!FIELDS[providerId]?.includes(field)) throw new Error("Unknown provider credential");
  }

  private validate(input: unknown): PersistedCredentials {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("credential file must be an object");
    const value = input as Record<string, unknown>;
    if (value.version !== 1 || !value.providers || typeof value.providers !== "object" || Array.isArray(value.providers)) throw new Error("credential file schema is invalid");
    const output: PersistedCredentials = { version: 1, providers: {} };
    for (const [providerId, fields] of Object.entries(value.providers as Record<string, unknown>)) {
      if (!(providerId in FIELDS) || !fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("credential file contains an unknown provider");
      for (const [field, credential] of Object.entries(fields as Record<string, unknown>)) {
        this.assertField(providerId as ProviderId, field as CredentialField);
        if (credential !== null && (typeof credential !== "string" || !credential)) throw new Error("credential file contains an invalid value");
        ((output.providers[providerId as ProviderId] ??= {}) as Record<string, CredentialValue>)[field] = credential as CredentialValue;
      }
    }
    return output;
  }

  private async persist(value: PersistedCredentials): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.provider-credentials.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
