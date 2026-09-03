import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface ClientKeyRecord {
  id: string;
  label: string;
  hash: string;
  createdAt: string;
}

interface PersistedClientKeys {
  version: 1;
  keys: ClientKeyRecord[];
}

export interface ClientKeyStatus {
  id: string;
  label: string;
  createdAt: string;
}

export class ClientApiKeyStore {
  private state: PersistedClientKeys = { version: 1, keys: [] };
  private queue: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "secrets");
    this.filePath = path.join(this.directory, "client-api-keys.json");
  }

  async load(): Promise<void> {
    try {
      this.state = this.validate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not load client API keys: ${(error as Error).message}`);
    }
  }

  list(): ClientKeyStatus[] {
    return this.state.keys.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  hasKeys(): boolean {
    return this.state.keys.length > 0;
  }

  matches(candidate: string): boolean {
    if (!candidate) return false;
    const digest = Buffer.from(hash(candidate), "hex");
    return this.state.keys.some((entry) => {
      const stored = Buffer.from(entry.hash, "hex");
      return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
  }

  async create(input: unknown): Promise<{ key: ClientKeyStatus; secret: string }> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "label")) throw new Error("Client key body may contain only label");
    const label = (input as { label?: unknown }).label;
    if (typeof label !== "string" || !label.trim() || label.trim().length > 80 || /[\0-\x1f\x7f]/.test(label)) throw new Error("Client key label must be 1 to 80 printable characters");
    const secret = `rtk_${randomBytes(32).toString("base64url")}`;
    const record: ClientKeyRecord = { id: randomUUID(), label: label.trim(), hash: hash(secret), createdAt: new Date().toISOString() };
    await this.mutate((next) => {
      if (next.keys.length >= 64) throw new Error("Client API key limit reached");
      next.keys.push(record);
    });
    return { key: { id: record.id, label: record.label, createdAt: record.createdAt }, secret };
  }

  async revoke(id: string): Promise<ClientKeyStatus> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Client key id is invalid");
    return this.mutate((next) => {
      const existing = next.keys.find((entry) => entry.id === id);
      if (!existing) throw new Error("Client API key not found");
      next.keys = next.keys.filter((entry) => entry.id !== id);
      return { id: existing.id, label: existing.label, createdAt: existing.createdAt };
    });
  }

  private async mutate<T>(change: (next: PersistedClientKeys) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private validate(input: unknown): PersistedClientKeys {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("client key file must be an object");
    const value = input as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.keys) || value.keys.length > 64) throw new Error("client key file schema is invalid");
    const ids = new Set<string>();
    const keys = value.keys.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("client key file contains an invalid entry");
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || ids.has(record.id) || typeof record.label !== "string" || !record.label || record.label.length > 80 || typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash) || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("client key file contains an invalid entry");
      ids.add(record.id);
      return { id: record.id, label: record.label, hash: record.hash, createdAt: record.createdAt };
    });
    return { version: 1, keys };
  }

  private async persist(value: PersistedClientKeys): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.client-api-keys.${randomUUID()}.tmp`);
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

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
