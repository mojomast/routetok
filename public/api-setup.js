(function () {
  "use strict";
  const REMEDIATION_401 = "Test request was rejected (HTTP 401). Confirm the application uses the complete one-time rtk_ secret as either Authorization: Bearer <key> or x-api-key: <key>. API Setup lists labels and IDs, not secret values. If the secret was lost, revoke that entry and create a replacement. The environment PROXY_API_KEY remains a separate accepted credential.";
  const ENDPOINTS = [
    { id: "chat", label: "Chat Completions", method: "POST", path: "/chat/completions" },
    { id: "responses", label: "Responses", method: "POST", path: "/responses" },
    { id: "messages", label: "Anthropic Messages", method: "POST", path: "/messages" },
    { id: "models", label: "List Models", method: "GET", path: "/models" }
  ];

  function resolveBaseUrl(explicit) {
    if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim().replace(/\/+$/, "");
    return `${location.origin}/v1`;
  }

  function buildCurlExample(baseUrl) {
    return [
      `curl ${baseUrl}/chat/completions \\`,
      `  -H "Authorization: Bearer $ROUTETOK_PROXY_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model":"best","messages":[{"role":"user","content":"Hello"}]}'`
    ].join("\n");
  }

  function makeNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function copyText(text, statusNode, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      statusNode.textContent = okMessage;
      return true;
    } catch (error) {
      statusNode.textContent = error && error.name === "NotAllowedError"
        ? "Clipboard permission was denied. Select the text manually."
        : "Clipboard access was unavailable. Select the text manually.";
      return false;
    }
  }

  function mount(el, options) {
    const settings = options || {};
    const fetchWithAuth = settings.fetchWithAuth || fetch;
    const baseUrl = resolveBaseUrl(settings.baseUrl);
    const curlExample = buildCurlExample(baseUrl);
    el.textContent = "";
    const container = makeNode("div", "api-setup-drawer");
    const heading = makeNode("h2", "api-setup-heading", "Connect Applications");
    container.append(heading);
    if (typeof settings.onClose === "function") {
      const closeButton = makeNode("button", "button api-setup-close", "Close");
      closeButton.type = "button";
      closeButton.setAttribute("data-api-setup-close", "true");
      closeButton.addEventListener("click", () => settings.onClose());
      container.append(closeButton);
    }
    const copyStatus = makeNode("p", "api-setup-copy-status muted");
    copyStatus.setAttribute("data-api-setup", "copy-status");
    copyStatus.setAttribute("role", "status");
    const baseSection = makeNode("section", "api-setup-section");
    baseSection.setAttribute("data-api-setup-section", "base-url");
    baseSection.append(makeNode("h3", null, "Base URL"));
    const baseCode = makeNode("code", "api-setup-base-url", baseUrl);
    baseCode.setAttribute("data-api-setup", "base-url");
    const baseCopy = makeNode("button", "button", "Copy");
    baseCopy.type = "button";
    baseCopy.setAttribute("data-api-setup-copy", "base-url");
    baseSection.append(baseCode, baseCopy);
    const endpointSection = makeNode("section", "api-setup-section");
    endpointSection.setAttribute("data-api-setup-section", "endpoints");
    endpointSection.append(makeNode("h3", null, "Endpoints"));
    const endpointList = makeNode("ul", "api-setup-endpoints");
    for (const endpoint of ENDPOINTS) {
      const item = makeNode("li", "api-setup-endpoint");
      const reference = makeNode("code", null, `${endpoint.method} ${baseUrl}${endpoint.path}`);
      reference.setAttribute("data-api-setup-endpoint", endpoint.id);
      reference.title = endpoint.label;
      const copyButton = makeNode("button", "button", "Copy");
      copyButton.type = "button";
      copyButton.setAttribute("data-api-setup-copy", `endpoint:${endpoint.id}`);
      copyButton.setAttribute("aria-label", `Copy ${endpoint.label} URL`);
      item.append(reference, copyButton);
      endpointList.append(item);
    }
    endpointSection.append(endpointList);
    const curlSection = makeNode("section", "api-setup-section");
    curlSection.setAttribute("data-api-setup-section", "curl");
    curlSection.append(makeNode("h3", null, "Example request"));
    const curlHint = makeNode("p", "muted", "Reads ROUTETOK_PROXY_KEY from the caller environment. No secret is stored here.");
    const curlBlock = makeNode("pre", "api-setup-curl-block");
    const curlCode = makeNode("code", null, curlExample);
    curlCode.setAttribute("data-api-setup", "curl-example");
    curlBlock.append(curlCode);
    const curlCopy = makeNode("button", "button", "Copy");
    curlCopy.type = "button";
    curlCopy.setAttribute("data-api-setup-copy", "curl");
    curlSection.append(curlHint, curlBlock, curlCopy);
    const authStatus = makeNode("p", "api-setup-auth-status muted", "Client authentication accepts managed rtk_ keys and the environment PROXY_API_KEY. Secret values are never displayed here.");
    authStatus.setAttribute("data-api-setup", "auth-status");
    const clientSection = makeNode("section", "api-setup-section");
    clientSection.setAttribute("data-api-setup-section", "client-keys");
    clientSection.append(makeNode("h3", null, "Client keys"));
    clientSection.append(makeNode("p", "muted", "Client keys authorize applications calling this proxy. Send one as Authorization: Bearer <key> or x-api-key: <key>."));
    const keyLabel = makeNode("label", "api-setup-key-label", "Paste a client key to test");
    const keyInput = makeNode("input", "api-setup-key-input");
    keyInput.type = "password";
    keyInput.setAttribute("autocomplete", "off");
    keyInput.setAttribute("autocapitalize", "off");
    keyInput.spellcheck = false;
    keyInput.placeholder = "Paste a client key (rtk_...)";
    keyInput.setAttribute("aria-label", "Client key for test request");
    keyLabel.append(keyInput);
    const sendButton = makeNode("button", "button primary", "Send test request");
    sendButton.type = "button";
    sendButton.setAttribute("data-api-setup", "send-test");
    const testResult = makeNode("p", "api-setup-test-result muted");
    testResult.setAttribute("data-api-setup", "test-result");
    testResult.setAttribute("role", "status");
    clientSection.append(keyLabel, sendButton, testResult);
    const providerSection = makeNode("section", "api-setup-section");
    providerSection.setAttribute("data-api-setup-section", "provider-credentials");
    providerSection.append(makeNode("h3", null, "Provider credentials"));
    providerSection.append(makeNode("p", "muted", "Provider credentials authorize RouteTok to call upstream services. They are write-only and never returned to the browser."));
    if (typeof settings.onManageProviderCredentials === "function") {
      const manageButton = makeNode("button", "button", "Manage provider credentials");
      manageButton.type = "button";
      manageButton.setAttribute("data-api-setup", "manage-providers");
      manageButton.addEventListener("click", () => settings.onManageProviderCredentials());
      providerSection.append(manageButton);
    }
    container.append(baseSection, endpointSection, curlSection, authStatus, copyStatus, clientSection, providerSection);
    el.append(container);
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-api-setup-copy]");
      if (!button || !container.contains(button)) return;
      const target = button.getAttribute("data-api-setup-copy");
      if (target === "base-url") void copyText(baseUrl, copyStatus, "Base URL copied.");
      else if (target === "curl") void copyText(curlExample, copyStatus, "Curl example copied.");
      else if (typeof target === "string" && target.startsWith("endpoint:")) {
        const endpoint = ENDPOINTS.find((candidate) => candidate.id === target.slice(9));
        if (endpoint) void copyText(baseUrl + endpoint.path, copyStatus, `${endpoint.label} URL copied.`);
      }
    });
    async function sendTest() {
      let currentKey = keyInput.value.trim();
      keyInput.value = "";
      if (!currentKey) {
        testResult.textContent = "Paste a client key to send a test request.";
        return;
      }
      testResult.textContent = "Sending test request...";
      sendButton.disabled = true;
      try {
        const response = await fetchWithAuth(baseUrl + "/models", {
          method: "GET",
          headers: { Authorization: "Bearer " + currentKey }
        });
        if (response.status === 401) {
          testResult.textContent = REMEDIATION_401;
          return;
        }
        if (!response.ok) {
          testResult.textContent = `Test request failed: HTTP ${response.status}.`;
          return;
        }
        const payload = await response.json();
        const advertised = Array.isArray(payload.data) ? payload.data.length : 0;
        testResult.textContent = `Test request succeeded (HTTP 200): ${advertised} models advertised.`;
      } catch (error) {
        testResult.textContent = `Test request failed: ${error && error.message ? error.message : "network error"}.`;
      } finally {
        keyInput.value = "";
        currentKey = "";
        sendButton.disabled = false;
      }
    }
    sendButton.addEventListener("click", () => void sendTest());
    keyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void sendTest();
      }
    });
    return {
      sendTest,
      unmount() {
        el.textContent = "";
      },
      getBaseUrl() {
        return baseUrl;
      },
      getEndpoints() {
        return ENDPOINTS.map((endpoint) => ({ ...endpoint }));
      }
    };
  }

  window.ApiSetup = {
    mount,
    buildCurlExample,
    endpoints: ENDPOINTS
  };
})();
