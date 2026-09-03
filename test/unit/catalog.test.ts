import assert from "node:assert/strict";
import test from "node:test";
import { CatalogService } from "../../src/catalog.js";
import type { ProviderRuntime } from "../../src/types.js";

test("failed catalogs retry after a short backoff instead of the normal refresh interval", async (context) => {
  let now = 1_700_000_000_000;
  let requests = 0;
  context.mock.method(Date, "now", () => now);
  const provider: ProviderRuntime = {
    id: "generic", configured: true, apiKey: "", auth: "none", baseUrl: "http://catalog.test/v1", endpoints: ["chat"]
  };
  const catalog = new CatalogService([provider], async () => {
    requests += 1;
    return requests === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ data: [{ id: "local-model" }] });
  });

  await catalog.refresh();
  assert.equal(requests, 1);
  assert.match(catalog.status().lastError ?? "", /HTTP 503/);
  await catalog.refreshIfStale(24);
  assert.equal(requests, 1, "failure backoff must suppress an immediate retry");

  now += 30_000;
  await catalog.refreshIfStale(24);
  assert.equal(requests, 2);
  assert.equal(catalog.status().lastError, null);
  assert.equal(catalog.resolve("generic:local-model")?.source, "live");
});
