import assert from "node:assert/strict";
import test from "node:test";
import { CreditsService } from "../../src/credits.js";
import type { ProviderRuntime } from "../../src/types.js";

test("blank credit fields remain unknown instead of becoming zero", async () => {
  const providers: ProviderRuntime[] = [{
    id: "openrouter", configured: true, apiKey: "provider-key", managementKey: "management-key", baseUrl: "http://credits.test/v1"
  }];
  const credits = new CreditsService(providers, async (input) => {
    const url = String(input);
    if (url.endsWith("/key")) return Response.json({ data: { usage: " ", limit: "", limit_remaining: "\t" } });
    return Response.json({ data: { total_credits: "", total_usage: "  " } });
  });

  await credits.refresh();
  assert.deepEqual(credits.get("openrouter")[0], {
    providerId: "openrouter", supported: true, fetchedAt: credits.get("openrouter")[0]?.fetchedAt ?? null,
    error: null, balanceUsd: null, usageUsd: null, limitUsd: null, remainingUsd: null
  });
});
