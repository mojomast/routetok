import type { ProviderCredits, ProviderId, ProviderRuntime } from "./types.js";

const amount = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const pick = (source: Record<string, unknown>, names: string[]): number | null => {
  for (const name of names) {
    const value = amount(source[name]);
    if (value !== null) return value;
  }
  return null;
};

export class CreditsService {
  private readonly cache = new Map<ProviderId, ProviderCredits>();

  constructor(private readonly providers: ProviderRuntime[], private readonly fetchImpl: typeof fetch = fetch) {
    for (const provider of providers) {
      this.cache.set(provider.id, this.empty(provider.id, provider.id === "openrouter" || provider.id === "requesty"));
    }
  }

  get(providerId?: ProviderId): ProviderCredits[] {
    const values = providerId ? [this.cache.get(providerId)].filter(Boolean) : [...this.cache.values()];
    return structuredClone(values as ProviderCredits[]);
  }

  async refresh(providerId?: ProviderId): Promise<ProviderCredits[]> {
    const providers = this.providers.filter((provider) => provider.configured && (!providerId || provider.id === providerId));
    if (providerId && !this.providers.some((provider) => provider.id === providerId)) throw new Error(`Unknown provider: ${providerId}`);
    await Promise.all(providers.map((provider) => this.fetchProvider(provider)));
    return this.get(providerId);
  }

  async providerChanged(providerId: ProviderId): Promise<ProviderCredits[]> {
    const provider = this.providers.find((entry) => entry.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    this.cache.set(providerId, this.empty(providerId, providerId === "openrouter" || providerId === "requesty"));
    if (provider.configured) await this.fetchProvider(provider);
    return this.get(providerId);
  }

  private empty(providerId: ProviderId, supported: boolean): ProviderCredits {
    return { providerId, supported, fetchedAt: null, error: null, balanceUsd: null, usageUsd: null, limitUsd: null, remainingUsd: null };
  }

  private async json(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`credits returned HTTP ${response.status}`);
    return object(await response.json());
  }

  private async fetchProvider(provider: ProviderRuntime): Promise<void> {
    if (provider.id !== "openrouter" && provider.id !== "requesty") {
      this.cache.set(provider.id, this.empty(provider.id, false));
      return;
    }
    const previous = this.cache.get(provider.id) ?? this.empty(provider.id, true);
    try {
      let result: ProviderCredits;
      if (provider.id === "openrouter") {
        const keyPayload = await this.json(`${provider.baseUrl}/key`, { authorization: `Bearer ${provider.apiKey}` });
        const keyData = object(keyPayload.data ?? keyPayload);
        let usage = pick(keyData, ["usage", "usage_daily", "usage_monthly"]);
        let limit = pick(keyData, ["limit"]);
        let remaining = pick(keyData, ["limit_remaining"]);
        let balance: number | null = null;
        if (provider.managementKey) {
          const creditsPayload = await this.json(`${provider.baseUrl}/credits`, { authorization: `Bearer ${provider.managementKey}` });
          const data = object(creditsPayload.data ?? creditsPayload);
          const total = pick(data, ["total_credits", "credits"]);
          usage = pick(data, ["total_usage", "usage"]) ?? usage;
          balance = total !== null && usage !== null ? Math.max(0, total - usage) : total;
          limit = total ?? limit;
          remaining = balance ?? remaining;
        }
        result = { providerId: provider.id, supported: true, fetchedAt: new Date().toISOString(), error: null,
          balanceUsd: balance, usageUsd: usage, limitUsd: limit,
          remainingUsd: remaining ?? balance ?? (limit !== null && usage !== null ? Math.max(0, limit - usage) : null) };
      } else {
        const base = provider.managementBaseUrl!;
        const headers = { authorization: `Bearer ${provider.apiKey}` };
        const [org, self] = await Promise.allSettled([
          this.json(`${base}/v1/manage/org`, headers),
          this.json(`${base}/v1/manage/apikey/self`, headers)
        ]);
        if (org.status === "rejected" && self.status === "rejected") throw org.reason;
        const orgData = org.status === "fulfilled" ? object(org.value.data ?? org.value) : {};
        const selfData = self.status === "fulfilled" ? object(self.value.data ?? self.value) : {};
        const balance = pick(orgData, ["balance", "credit_balance", "credits"]);
        const usage = pick(selfData, ["monthly_spend", "spend", "usage"]);
        const rawLimit = pick(selfData, ["monthly_limit", "limit"]);
        const limit = rawLimit === 0 ? null : rawLimit;
        result = { providerId: provider.id, supported: true, fetchedAt: new Date().toISOString(), error: null,
          balanceUsd: balance, usageUsd: usage, limitUsd: limit,
          remainingUsd: balance ?? (limit !== null && usage !== null ? Math.max(0, limit - usage) : null) };
      }
      this.cache.set(provider.id, result);
    } catch (error) {
      this.cache.set(provider.id, { ...previous, fetchedAt: new Date().toISOString(), error: (error as Error).message });
    }
  }
}
