import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const files = {
  apiSetup: "public/api-setup.js",
  dashboardHtml: "public/index.html",
  dashboard: "public/app.js"
} as const;

async function loadApiSetup(): Promise<string> {
  return readFile(files.apiSetup, "utf8");
}

test("dashboard loads and mounts the ApiSetup module from the guide dialog", async () => {
  const [html, script] = await Promise.all([readFile(files.dashboardHtml, "utf8"), readFile(files.dashboard, "utf8")]);
  assert.match(html, /<script defer src="\/api-setup\.js/);
  assert.match(html, /id="api-setup-root"/);
  assert.match(script, /mountDashboardModule\("ApiSetup", "api-setup-root"/);
  assert.match(script, /window\[globalName\]\.mount\(root, options\)/);
});

test("api setup exposes a mountable drawer module", async () => {
  const script = await loadApiSetup();
  assert.match(script, /window\.ApiSetup\s*=/);
  assert.match(script, /function mount\(el,/);
  assert.match(script, /fetchWithAuth/);
  assert.match(script, /baseUrl/);
  assert.match(script, /getBaseUrl\(\)/);
  assert.match(script, /unmount\(\)/);
});

test("copy targets cover base URL, every endpoint, and the curl example", async () => {
  const script = await loadApiSetup();
  assert.match(script, /data-api-setup-copy/);
  assert.match(script, /data-api-setup-copy", "base-url"/);
  assert.match(script, /data-api-setup-copy", "curl"/);
  assert.match(script, /endpoint:\$\{endpoint\.id\}/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /baseUrl \+ endpoint\.path/);
  assert.match(script, /ROUTETOK_PROXY_KEY/);
  assert.match(script, /Authorization: Bearer \$ROUTETOK_PROXY_KEY/);
});

test("endpoint references cover chat, responses, anthropic, and model listing", async () => {
  const script = await loadApiSetup();
  assert.match(script, /\/chat\/completions/);
  assert.match(script, /\/responses/);
  assert.match(script, /\/messages/);
  assert.match(script, /\/models/);
  assert.match(script, /Chat Completions/);
  assert.match(script, /Anthropic Messages/);
  assert.match(script, /List Models/);
  assert.match(script, /location\.origin.*\/v1/);
});

test("test request renders model count and clean 401 remediation", async () => {
  const script = await loadApiSetup();
  assert.match(script, /baseUrl \+ "\/models"/);
  assert.match(script, /Authorization/);
  assert.match(script, /Bearer " \+ currentKey/);
  assert.match(script, /response\.status === 401/);
  assert.match(script, /response\.json\(\)/);
  assert.match(script, /payload\.data/);
  assert.match(script, /models advertised/);
  assert.match(script, /HTTP 200/);
  assert.match(script, /rtk_/);
  assert.match(script, /x-api-key/);
  assert.match(script, /revoke that entry and create a replacement/);
});

test("pasted keys use a password field, are cleared, and never persist, render, or log", async () => {
  const script = await loadApiSetup();
  assert.match(script, /type = "password"/);
  assert.match(script, /autocomplete", "off"/);
  assert.match(script, /\.value = ""/);
  assert.match(script, /currentKey = ""/);
  assert.match(script, /data-api-setup-section", "client-keys"/);
  assert.match(script, /data-api-setup-section", "provider-credentials"/);
  assert.match(script, /Client keys authorize applications calling this proxy/);
  assert.match(script, /Provider credentials authorize RouteTok to call upstream services/);
  assert.doesNotMatch(script, /localStorage/);
  assert.doesNotMatch(script, /sessionStorage/);
  assert.doesNotMatch(script, /console\./);
  assert.doesNotMatch(script, /innerHTML/);
  assert.doesNotMatch(script, /outerHTML/);
  assert.doesNotMatch(script, /insertAdjacentHTML/);
  assert.doesNotMatch(script, /process\.env/);
  assert.doesNotMatch(script, /document\.cookie/);
});

test("dashboard proxy-key tests do not use dashboard authentication or its login dialog", async () => {
  const script = await readFile(files.dashboard, "utf8");
  const mount = script.match(/mountDashboardModule\("ApiSetup", "api-setup-root", \{[\s\S]*?\n\}\);/);
  assert.ok(mount);
  let settings: Record<string, unknown> | undefined;
  vm.runInNewContext(mount[0], {
    mountDashboardModule: (_name: string, _root: string, options: Record<string, unknown>) => { settings = options; },
    moduleFetch: () => { throw new Error("Dashboard auth must not be used for proxy-key tests"); }
  });
  assert.ok(settings);
  assert.equal(settings.fetchWithAuth, undefined, "use ApiSetup's plain fetch default");
});

test("API Setup sends only the client key and prevents overlapping keyboard submissions", async () => {
  class Node {
    textContent = "";
    value = "";
    type = "";
    disabled = false;
    attributes: Record<string, string> = {};
    listeners: Record<string, (event: { key: string; preventDefault(): void }) => void> = {};
    append(..._nodes: Node[]) {}
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    addEventListener(name: string, listener: (event: { key: string; preventDefault(): void }) => void) { this.listeners[name] = listener; }
  }
  const nodes: Node[] = [];
  const calls: { url: string; options: RequestInit }[] = [];
  let finish: (response: unknown) => void = () => { throw new Error("No pending request"); };
  const holder: { ApiSetup?: { mount(root: Node): { sendTest(): Promise<void> } } } = {};
  vm.runInNewContext(await loadApiSetup(), {
    window: holder,
    location: { origin: "https://router.test" },
    document: { createElement: () => { const node = new Node(); nodes.push(node); return node; } },
    fetch: (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  assert.ok(holder.ApiSetup);
  const panel = holder.ApiSetup.mount(new Node());
  const input = nodes.find((node) => node.type === "password");
  const button = nodes.find((node) => node.attributes["data-api-setup"] === "send-test");
  const result = nodes.find((node) => node.attributes["data-api-setup"] === "test-result");
  assert.ok(input && button && result);
  input.value = "rtk_test_only";
  const pending = panel.sendTest();
  assert.equal(input.value, "");
  assert.equal(input.disabled, true);
  assert.equal(button.disabled, true);
  input.listeners.keydown?.({ key: "Enter", preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(result.textContent, "Sending test request...");
  assert.equal(calls[0]?.url, "https://router.test/v1/models");
  assert.equal(JSON.stringify(calls[0]?.options.headers), JSON.stringify({ Authorization: "Bearer rtk_test_only" }));
  finish({ status: 401, ok: false });
  await pending;
  assert.match(result.textContent, /HTTP 401/);
  assert.doesNotMatch(result.textContent, /rtk_test_only/);
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);

  input.value = "rtk_replacement";
  const retry = panel.sendTest();
  finish({ status: 200, ok: true, json: async () => ({ data: [{ id: "best" }] }) });
  await retry;
  assert.equal(calls.length, 2);
  assert.match(result.textContent, /1 models advertised/);
  assert.equal(input.value, "");
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);
});
