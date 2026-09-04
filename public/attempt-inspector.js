(() => {
  const TERMINAL_LABELS = {
    complete: "Complete — request finished successfully",
    rate_limited: "Rate limited — upstream throttled the request",
    fallback_exhausted: "Fallback exhausted — every candidate failed",
    non_retryable: "Non-retryable — upstream returned a permanent error",
    request_timeout: "Request timeout — no output before the deadline",
    client_cancelled: "Client cancelled — request was aborted",
    no_candidate: "No candidate — no route was eligible",
    invalid_request: "Invalid request — rejected before routing",
    stream_committed: "Stream committed — output started, no further fallback"
  };
  const SECRET_HEADER_NAMES = new Set([
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-dashboard-token",
    "api-key",
    "apikey",
    "cookie",
    "set-cookie"
  ]);
  const SECRET_NAME_PATTERN = /token|secret|passwd|password|auth|api[_-]?key|cookie|bearer/i;
  const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_\/:.,@%+=~\-]+$/;
  const MAX_DECODED_CHARS = 65536;

  function isSecretHeaderName(name) {
    const lower = String(name).trim().toLowerCase();
    return SECRET_HEADER_NAMES.has(lower) || SECRET_NAME_PATTERN.test(lower);
  }

  function normalizeBase64Url(input) {
    const clean = String(input).trim().replace(/\s+/g, "");
    if (!clean) throw new Error("Empty attempt summary header");
    if (!/^[A-Za-z0-9\-_]*={0,2}$/.test(clean)) throw new Error("Malformed attempt summary header");
    if (clean.length % 4 === 1) throw new Error("Malformed attempt summary header");
    return clean;
  }

  function base64UrlDecodeToString(input) {
    const clean = normalizeBase64Url(input);
    const standard = clean.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      const text = Buffer.from(padded, "base64").toString("utf-8");
      if (text.length > MAX_DECODED_CHARS) throw new Error("Attempt summary payload too large");
      return text;
    }
    if (typeof atob !== "function" || typeof TextDecoder === "undefined") {
      throw new Error("Base64 decoding is not available");
    }
    let binary = "";
    try {
      binary = atob(padded);
    } catch {
      throw new Error("Malformed attempt summary header");
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > MAX_DECODED_CHARS) throw new Error("Attempt summary payload too large");
    return text;
  }

  function normalizeAttempt(entry) {
    const source = entry && typeof entry === "object" ? entry : {};
    const status = typeof source.s === "number" && Number.isInteger(source.s) ? source.s : null;
    return {
      p: String(source.p ?? "").slice(0, 32),
      m: String(source.m ?? "").slice(0, 96),
      s: status,
      o: String(source.o ?? "").slice(0, 32)
    };
  }

  function decodeAttemptSummary(header) {
    if (typeof header !== "string" || !header.trim()) throw new Error("Empty attempt summary header");
    let payload = null;
    try {
      payload = JSON.parse(base64UrlDecodeToString(header));
    } catch (error) {
      if (error instanceof Error && /too large/.test(error.message)) throw error;
      throw new Error("Malformed attempt summary header");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Malformed attempt summary header");
    }
    if (payload.v !== 1) throw new Error("Unsupported attempt summary version");
    let rawAttempts = [];
    if (payload.a === undefined) rawAttempts = [];
    else if (Array.isArray(payload.a)) rawAttempts = payload.a;
    else throw new Error("Malformed attempt summary header");
    const attempts = rawAttempts.map(normalizeAttempt);
    const total = Number.isInteger(payload.t) && payload.t >= 0 ? payload.t : attempts.length;
    return { version: 1, attempts, total, truncated: total > attempts.length };
  }

  function humanizeTerminal(value) {
    const key = String(value ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(TERMINAL_LABELS, key)) return TERMINAL_LABELS[key];
    if (!key) return "Unknown terminal state";
    return `Unknown terminal state: ${key}`;
  }

  function shellQuote(value) {
    const text = String(value);
    if (text && SAFE_SHELL_TOKEN.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
  }

  function redactUrlCredentials(url) {
    const text = String(url || "");
    try {
      const parsed = new URL(text);
      if (parsed.username || parsed.password) {
        parsed.username = "REDACTED";
        parsed.password = "";
        return parsed.toString();
      }
      return text;
    } catch {
      return text.replace(/:\/\/[^/\s@]+@/g, "://REDACTED@");
    }
  }

  function headerEntries(headers) {
    if (!headers) return [];
    if (Array.isArray(headers)) {
      return headers
        .filter((item) => Array.isArray(item) && item.length >= 2)
        .map((item) => [String(item[0]), String(item[1])]);
    }
    if (typeof headers === "object") return Object.entries(headers).map(([k, v]) => [String(k), String(v)]);
    return [];
  }

  function buildReplayCurl(request) {
    const source = request && typeof request === "object" ? request : {};
    const method = String(source.method || "GET").toUpperCase() || "GET";
    const url = redactUrlCredentials(source.url || "");
    if (!url) throw new Error("Curl replay needs a request URL");
    const parts = ["curl", "--fail", "--show-error", "-X", shellQuote(method), shellQuote(url)];
    for (const [name, value] of headerEntries(source.headers)) {
      const trimmedName = name.trim();
      if (!trimmedName) continue;
      const safeValue = isSecretHeaderName(trimmedName) ? "REDACTED" : value;
      parts.push("-H", shellQuote(`${trimmedName}: ${safeValue}`));
    }
    if (typeof source.body === "string" && source.body) parts.push("--data-binary", shellQuote(source.body));
    return parts.join(" ");
  }

  function parseHeaderLines(text) {
    const headers = {};
    for (const line of String(text || "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const index = trimmed.indexOf(":");
      if (index <= 0) continue;
      const name = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (name) headers[name] = value;
    }
    return headers;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function readFetcherPayload(result) {
    if (result && typeof result.json === "function") {
      if ("ok" in result && !result.ok) {
        let message = `HTTP ${result.status}`;
        try {
          const payload = await result.json();
          if (payload && typeof payload.error === "string") message = payload.error;
          else if (payload && payload.error && typeof payload.error.message === "string") message = payload.error.message;
        } catch {}
        throw new Error(message);
      }
      return result.json();
    }
    return result;
  }

  function requestCandidates(payload) {
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.requests)) return payload.requests;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.samples)) return payload.samples;
    if (Array.isArray(payload.live)) return payload.live;
    return [];
  }

  function candidateToReplay(item) {
    if (!item || typeof item !== "object") return null;
    const nested = item.request && typeof item.request === "object" ? item.request : {};
    const headerBag = item.headers && typeof item.headers === "object" ? item.headers : nested.headers;
    const headers = {};
    if (headerBag && typeof headerBag === "object" && !Array.isArray(headerBag)) {
      for (const [name, value] of Object.entries(headerBag)) {
        if (typeof value === "string" && value) headers[name] = value;
      }
    }
    return {
      id: String(item.id ?? item.requestId ?? nested.id ?? ""),
      method: String(item.method ?? nested.method ?? "GET"),
      url: String(item.url ?? nested.url ?? item.path ?? ""),
      headers,
      terminal: String(item.terminal ?? nested.terminal ?? headers["x-router-terminal"] ?? ""),
      summary: String(item.attemptSummary ?? item.summary ?? headers["x-router-attempt-summary"] ?? "")
    };
  }

  function mount(root, options) {
    if (!root) throw new Error("Attempt inspector needs a mount element");
    const settings = options && typeof options === "object" ? options : {};
    const fetchWithAuth = typeof settings.fetchWithAuth === "function" ? settings.fetchWithAuth : null;
    root.textContent = "";
    const wrap = el("section", "ai-root");
    wrap.appendChild(el("h2", "ai-title", "Attempt Inspector"));

    const summaryLabel = el("label", "ai-label", "x-router-attempt-summary");
    const summaryInput = el("textarea", "ai-input");
    summaryInput.setAttribute("placeholder", "Paste x-router-attempt-summary value");
    summaryInput.setAttribute("rows", "3");
    summaryInput.setAttribute("spellcheck", "false");
    summaryLabel.appendChild(summaryInput);

    const terminalLabel = el("label", "ai-label", "x-router-terminal");
    const terminalInput = el("input", "ai-input");
    terminalInput.setAttribute("placeholder", "complete");
    terminalInput.setAttribute("spellcheck", "false");
    terminalLabel.appendChild(terminalInput);

    const replayGroup = el("div", "ai-replay-fields");
    const methodLabel = el("label", "ai-label", "Method");
    const methodInput = el("input", "ai-input");
    methodInput.value = "POST";
    methodLabel.appendChild(methodInput);
    const urlLabel = el("label", "ai-label", "Request URL");
    const urlInput = el("input", "ai-input");
    urlInput.setAttribute("placeholder", "https://host/v1/chat/completions");
    urlInput.setAttribute("spellcheck", "false");
    urlLabel.appendChild(urlInput);
    const headersLabel = el("label", "ai-label", "Request headers (Name: value per line)");
    const headersInput = el("textarea", "ai-input");
    headersInput.setAttribute("rows", "4");
    headersInput.setAttribute("spellcheck", "false");
    headersLabel.appendChild(headersInput);
    replayGroup.append(methodLabel, urlLabel, headersLabel);

    const controls = el("div", "ai-controls");
    const decodeButton = el("button", "ai-button", "Decode attempts");
    decodeButton.setAttribute("type", "button");
    const copyButton = el("button", "ai-button", "Copy curl replay");
    copyButton.setAttribute("type", "button");
    const liveButton = el("button", "ai-button", "Load live");
    liveButton.setAttribute("type", "button");
    const historyButton = el("button", "ai-button", "Load history");
    historyButton.setAttribute("type", "button");
    if (!fetchWithAuth) {
      liveButton.disabled = true;
      historyButton.disabled = true;
    }
    controls.append(decodeButton, copyButton, liveButton, historyButton);

    const pickerLabel = el("label", "ai-label", "Dashboard request");
    const picker = el("select", "ai-input");
    picker.appendChild(el("option", "", "Load live or history to pick a request"));
    pickerLabel.appendChild(picker);

    const errorBox = el("div", "ai-error");
    errorBox.setAttribute("role", "alert");
    errorBox.hidden = true;
    const terminalLine = el("div", "ai-terminal");
    terminalLine.hidden = true;
    const badge = el("div", "ai-badge");
    badge.hidden = true;
    const timeline = el("ol", "ai-timeline");
    const curlOut = el("pre", "ai-curl");
    const copyStatus = el("div", "ai-status");
    copyStatus.setAttribute("aria-live", "polite");

    wrap.append(summaryLabel, terminalLabel, replayGroup, controls, pickerLabel, errorBox, terminalLine, badge, timeline, curlOut, copyStatus);
    root.appendChild(wrap);

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    function clearError() {
      errorBox.textContent = "";
      errorBox.hidden = true;
    }

    function renderTimeline(decoded) {
      timeline.textContent = "";
      if (decoded.truncated) {
        badge.textContent = `truncated: showing ${decoded.attempts.length} of ${decoded.total} attempts`;
        badge.hidden = false;
      } else {
        badge.textContent = "";
        badge.hidden = true;
      }
      if (!decoded.attempts.length) {
        const empty = el("li", "ai-empty", decoded.truncated ? "Attempt entries were omitted" : "No attempts recorded");
        timeline.appendChild(empty);
        return;
      }
      decoded.attempts.forEach((attempt, index) => {
        const row = el("li", "ai-row");
        row.appendChild(el("span", "ai-index", `#${index + 1}`));
        row.appendChild(el("span", "ai-provider", attempt.p || "unknown provider"));
        row.appendChild(el("span", "ai-model", attempt.m || "unknown model"));
        row.appendChild(el("span", "ai-status", attempt.s === null ? "transport failure" : `HTTP ${attempt.s}`));
        row.appendChild(el("span", "ai-outcome", attempt.o || "unknown outcome"));
        timeline.appendChild(row);
      });
    }

    function renderCurl() {
      let command = "";
      try {
        command = buildReplayCurl({ method: methodInput.value, url: urlInput.value, headers: parseHeaderLines(headersInput.value) });
      } catch (error) {
        command = error instanceof Error ? error.message : "Curl replay needs a request URL";
      }
      curlOut.textContent = command;
      return command;
    }

    function decodeFromInputs() {
      clearError();
      try {
        const decoded = decodeAttemptSummary(summaryInput.value);
        renderTimeline(decoded);
        const humanized = humanizeTerminal(terminalInput.value);
        terminalLine.textContent = terminalInput.value.trim() ? `${terminalInput.value.trim()}: ${humanized}` : humanized;
        terminalLine.hidden = false;
      } catch (error) {
        timeline.textContent = "";
        badge.hidden = true;
        terminalLine.hidden = true;
        showError(error instanceof Error ? error.message : "Malformed attempt summary header");
      }
    }

    async function copyCurl() {
      clearError();
      const command = renderCurl();
      if (!urlInput.value.trim()) {
        showError("Curl replay needs a request URL");
        return;
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(command);
        } else {
          const area = document.createElement("textarea");
          area.value = command;
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          area.remove();
        }
        copyStatus.textContent = "Replay command copied without secret values";
      } catch {
        showError("Copy failed in this browser");
      }
    }

    function fillFromCandidate(candidate) {
      if (!candidate) return;
      clearError();
      methodInput.value = candidate.method || "GET";
      urlInput.value = candidate.url || "";
      const lines = [];
      for (const [name, value] of Object.entries(candidate.headers || {})) {
        lines.push(isSecretHeaderName(name) ? `${name}: REDACTED` : `${name}: ${value}`);
      }
      headersInput.value = lines.join("\n");
      if (candidate.summary) summaryInput.value = candidate.summary;
      if (candidate.terminal) terminalInput.value = candidate.terminal;
      decodeFromInputs();
      renderCurl();
    }

    async function loadDashboard(path) {
      if (!fetchWithAuth) return;
      clearError();
      copyStatus.textContent = "";
      try {
        const payload = await readFetcherPayload(await fetchWithAuth(path));
        const candidates = requestCandidates(payload).map(candidateToReplay).filter(Boolean);
        picker.textContent = "";
        if (!candidates.length) {
          picker.appendChild(el("option", "", "No requests available"));
          return;
        }
        picker.appendChild(el("option", "", "Pick a request"));
        for (const candidate of candidates) {
          const label = [candidate.id, candidate.method, candidate.url].filter(Boolean).join(" ").slice(0, 96) || "request";
          const option = el("option", "", label);
          option.value = candidate.id || label;
          option.dataset.payload = JSON.stringify({
            method: candidate.method,
            url: candidate.url,
            headers: candidate.headers,
            terminal: candidate.terminal,
            summary: candidate.summary
          });
          picker.appendChild(option);
        }
        copyStatus.textContent = `${candidates.length} requests loaded`;
      } catch (error) {
        showError(error instanceof Error ? error.message : "Dashboard request failed");
      }
    }

    decodeButton.addEventListener("click", decodeFromInputs);
    copyButton.addEventListener("click", () => void copyCurl());
    liveButton.addEventListener("click", () => void loadDashboard("/admin/api/live"));
    historyButton.addEventListener("click", () => void loadDashboard("/admin/api/history?limit=100"));
    picker.addEventListener("change", () => {
      const selected = picker.selectedOptions && picker.selectedOptions[0];
      if (!selected || !selected.dataset.payload) return;
      try {
        fillFromCandidate(JSON.parse(selected.dataset.payload));
      } catch {
        showError("Dashboard request failed");
      }
    });
    for (const node of [methodInput, urlInput, headersInput]) node.addEventListener("input", renderCurl);
    renderCurl();
  }

  const api = { decodeAttemptSummary, humanizeTerminal, buildReplayCurl, mount };
  if (typeof window !== "undefined") window.AttemptInspector = api;
  if (typeof globalThis !== "undefined" && typeof window === "undefined") globalThis.AttemptInspector = api;
})();
