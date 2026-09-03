const ARENA_MODES = ["chat", "design", "diagnose"];
const ARENA_WORKSPACES_KEY = "routetok-arena-workspaces-v1";
const AUDIO_SETTINGS_KEY = "routetok-arena-audio-settings-v1";
const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const AUDIO_MAX_MS = 3 * 60 * 1000;
const DEFAULT_TTS_MODEL = "openrouter:deepgram/flux-tts:free";
const DEFAULT_TTS_VOICE = "flux-alexis-en";

function createArenaWorkspace(mode, saved = {}) {
  const parameters = saved.parameters && typeof saved.parameters === "object" ? saved.parameters : {};
  return {
    mode,
    turns: [],
    runId: typeof saved.runId === "string" ? saved.runId : crypto.randomUUID(),
    draft: typeof saved.draft === "string" ? saved.draft : "",
    selectedModels: new Set(Array.isArray(saved.selectedModels) ? saved.selectedModels.slice(0, 4) : []),
    modelLineup: Array.isArray(saved.modelLineup) ? saved.modelLineup.filter((model) => typeof model === "string").slice(0, 4) : [],
    parameters: {
      providerDefaultMax: parameters.providerDefaultMax === true,
      maxTokens: Number.isFinite(Number(parameters.maxTokens)) ? Number(parameters.maxTokens) : 4096,
      temperature: parameters.temperature ?? "",
      topP: parameters.topP ?? ""
    },
    assistantPlan: null,
    configProposal: null,
    scrollTop: Number(saved.scrollTop) || 0,
    userScrolled: saved.userScrolled === true,
    busy: false,
    controller: null,
    pendingCards: new Map(),
    inflight: null,
    status: saved.status === "failed" ? "failed" : saved.draft ? "draft" : "ready",
    saveState: "ready",
    intent: ["auto", "diagnose", "explain", "onboard", "optimize", "configure", "compare"].includes(saved.intent) ? saved.intent : "auto"
  };
}

let storedArena = null;
try { storedArena = JSON.parse(localStorage.getItem(ARENA_WORKSPACES_KEY) || "null"); } catch {}
const storedArenaMode = "diagnose";

const state = {
  status: null,
  token: localStorage.getItem("routetok-dashboard-token") || localStorage.getItem("agentrouter-dashboard-token") || "",
  timer: null,
  sandboxLibraryOpen: false,
  sandboxLibraryStarredOnly: false,
  arenaWorkspaces: Object.fromEntries(ARENA_MODES.map((mode) => [mode, createArenaWorkspace(mode, storedArena?.workspaces?.[mode])])),
  sandboxMode: storedArenaMode,
  confirmingProposal: null,
  chatOpen: false,
  configOpen: false,
  expandedRequests: new Set(),
  expandedRequestContent: new Set(),
  requestContent: new Map(),
  requestContentLoading: new Set(),
  recentSignature: null,
  historySamples: [],
  historyRetained: 0,
  historyRequestCount: null,
  historyLastFetch: 0,
  historyUnavailable: false,
  liveVisuals: new Map(),
  metricAnimations: new Map(),
  liveTimer: null,
  liveUpdatesAvailable: false,
  liveLoadBusy: false,
  statusLoadBusy: false,
  customizeOpen: false,
  apiAccessOpen: false,
  modalInerted: [],
  commandOpen: false,
  commandIndex: 0,
  preferences: null,
  baseline: null,
  connectionState: "offline",
  lastSuccessfulLoad: 0,
  staleTimer: null,
  configDirty: false,
  configDraft: null,
  selectedModels: new Set(),
  selectedModelId: null,
  showAllModels: false,
  sandboxModelSignature: null,
  railExpanded: false,
  collapsedSections: new Set()
};
if (Number(storedArena?.version) < 3) {
  for (const workspace of Object.values(state.arenaWorkspaces)) workspace.intent = "auto";
}

const audioState = {
  capabilities: null,
  capabilitiesPromise: null,
  settings: { sttModel: "", language: "", ttsModel: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, speed: 1 },
  recorder: null,
  recordingRequest: 0,
  stream: null,
  chunks: [],
  bytes: 0,
  timer: null,
  sttController: null,
  transcriptTarget: null,
  ttsController: null,
  playback: null,
  playbackUrl: null,
  ttsButton: null,
  ttsKey: null
};
try {
  const savedAudio = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || "null");
  if (savedAudio && typeof savedAudio === "object") {
    for (const key of ["sttModel", "language", "ttsModel", "voice"]) if (typeof savedAudio[key] === "string") audioState.settings[key] = savedAudio[key];
    if (Number.isFinite(Number(savedAudio.speed))) audioState.settings.speed = Math.max(0.25, Math.min(4, Number(savedAudio.speed)));
  }
} catch {}

const activeWorkspace = () => state.arenaWorkspaces[state.sandboxMode];
function workspaceModelLanes(workspace = activeWorkspace()) {
  const models = workspace.modelLineup.length ? workspace.modelLineup : [...workspace.selectedModels];
  return models.slice(0, 4).map((model, index) => ({ id: `lane_${index}`, model, index }));
}
for (const [property, workspaceProperty] of Object.entries({
  chatTurns: "turns", sandboxRunId: "runId", assistantPlan: "assistantPlan",
  pendingSandboxCards: "pendingCards", chatBusy: "busy", chatController: "controller",
  sandboxSelectedModels: "selectedModels", configProposal: "configProposal", userScrolled: "userScrolled"
})) {
  Object.defineProperty(state, property, {
    configurable: true,
    get: () => activeWorkspace()[workspaceProperty],
    set: (value) => { activeWorkspace()[workspaceProperty] = value; }
  });
}

const byId = (id) => document.getElementById(id);
const firstById = (...ids) => ids.map(byId).find(Boolean) || null;
const PREFERENCES_KEY = "routetok-dashboard-preferences";
const BASELINE_KEY = "routetok-dashboard-baseline";
const FOCUS_MODE_KEY = "routetok-dashboard-focus-mode";
const SECTION_LAYOUT_KEY = "routetok-dashboard-section-layout-v1";
const SANDBOX_MODELS_KEY = "routetok-dashboard-sandbox-models-v1";
for (const [storage, next, legacy] of [
  [localStorage, PREFERENCES_KEY, "agentrouter-dashboard-preferences"], [localStorage, SECTION_LAYOUT_KEY, "agentrouter-dashboard-section-layout-v1"], [localStorage, SANDBOX_MODELS_KEY, "agentrouter-dashboard-sandbox-models-v1"],
  [sessionStorage, BASELINE_KEY, "agentrouter-dashboard-baseline"], [sessionStorage, FOCUS_MODE_KEY, "agentrouter-dashboard-focus-mode"]
]) {
  try { if (storage.getItem(next) === null && storage.getItem(legacy) !== null) storage.setItem(next, storage.getItem(legacy)); } catch {}
}
const LAYOUT_SECTIONS = [
  { key: "history", selector: ".history-panel", label: "Performance Trends" },
  { key: "models", selector: ".health-panel", label: "Model Fabric" },
  { key: "requests", selector: ".recent-panel", label: "Request Log" }
];
const PREFERENCE_DEFAULTS = Object.freeze({
  version: 5,
  theme: "router",
  accent: null,
  density: "comfortable",
  motion: "system",
  glow: 50,
  inflightPlacement: "left",
  completedLingerSeconds: 4,
  dashboardModelSort: "catalog",
  dashboardModelSortDirection: "asc",
  hiddenDashboardModels: []
});
const PREFERENCE_BUTTONS = {
  theme: { "theme-router": "router", "theme-paper": "paper", "theme-system": "system" },
  density: { "density-comfortable": "comfortable", "density-compact": "compact" },
  motion: { "motion-system": "system", "motion-full": "full", "motion-reduced": "reduced" }
};
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");

function normalizePreferences(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const theme = ["system", "router", "abyss", "ultraviolet", "ember", "paper"].includes(source.theme)
    ? source.theme
    : PREFERENCE_DEFAULTS.theme;
  const density = ["compact", "comfortable", "spacious"].includes(source.density)
    ? source.density
    : PREFERENCE_DEFAULTS.density;
  const motion = ["system", "full", "reduced"].includes(source.motion) ? source.motion : PREFERENCE_DEFAULTS.motion;
  let accent = typeof source.accent === "string" ? source.accent.trim() : null;
  if (/^#[0-9a-f]{3}$/i.test(accent || "")) accent = `#${[...accent.slice(1)].map((part) => part + part).join("")}`;
  if (!/^#[0-9a-f]{6}$/i.test(accent || "")) accent = null;
  if (accent) accent = accent.toLowerCase();
  const glow = typeof source.glow === "number" && Number.isFinite(source.glow)
    ? Math.round(Math.min(100, Math.max(0, source.glow)))
    : PREFERENCE_DEFAULTS.glow;
  const inflightPlacement = ["left", "right", "main"].includes(source.inflightPlacement)
    ? source.inflightPlacement
    : source.railSide === "right" ? "right" : "left";
  const completedLingerSeconds = Number.isFinite(Number(source.completedLingerSeconds))
    ? Math.max(0, Math.min(30, Math.round(Number(source.completedLingerSeconds))))
    : PREFERENCE_DEFAULTS.completedLingerSeconds;
  const dashboardModelSort = ["catalog", "name", "state", "success", "latency", "attempts", "tokens", "cost"].includes(source.dashboardModelSort) ? source.dashboardModelSort : PREFERENCE_DEFAULTS.dashboardModelSort;
  const dashboardModelSortDirection = source.dashboardModelSortDirection === "desc" ? "desc" : "asc";
  const hiddenDashboardModels = [...new Set(Array.isArray(source.hiddenDashboardModels) ? source.hiddenDashboardModels.filter((id) => typeof id === "string" && id.length <= 512).slice(0, 500) : [])];
  return { version: 5, theme, accent, density, motion, glow, inflightPlacement, completedLingerSeconds, dashboardModelSort, dashboardModelSortDirection, hiddenDashboardModels };
}

function readStoredJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function syncPreferenceControls() {
  const preferences = state.preferences;
  if (!preferences) return;
  const controls = {
    theme: firstById("customize-theme", "theme-setting", "preference-theme", "theme-preference", "theme-select"),
    accent: firstById("customize-accent", "accent-setting", "preference-accent", "accent-color", "accent-picker"),
    density: firstById("customize-density", "density-setting", "preference-density", "density-preference", "density-select"),
    motion: firstById("customize-motion", "motion-setting", "preference-motion", "motion-preference", "motion-select"),
    glow: firstById("customize-glow", "glow-setting", "preference-glow", "glow-range", "glow-slider"),
    inflightPlacement: byId("customize-rail-side"),
    completedLingerSeconds: byId("inflight-linger"),
    dashboardModelSort: byId("health-model-sort"),
    dashboardModelSortDirection: byId("health-model-sort-direction")
  };
  for (const [key, control] of Object.entries(controls)) {
    if (!control) continue;
    control.value = key === "accent"
      ? preferences.accent || (control.type === "color" ? "#c5f459" : "")
      : String(preferences[key]);
  }
  for (const key of ["theme", "density", "motion"]) {
    const buttons = [
      ...document.querySelectorAll(`[data-preference="${key}"]`),
      ...Object.keys(PREFERENCE_BUTTONS[key]).map(byId).filter(Boolean)
    ];
    for (const button of new Set(buttons)) {
      const value = button.dataset.value || PREFERENCE_BUTTONS[key][button.id];
      const active = value === preferences[key];
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  const glowValue = firstById("customize-glow-value", "glow-value", "preference-glow-value");
  if (glowValue) glowValue.textContent = `${preferences.glow}%`;
  const accentStatus = byId("customize-accent-status");
  if (accentStatus) accentStatus.textContent = preferences.accent
    ? `Custom accent ${preferences.accent}.`
    : "Using theme accent.";
  const lingerValue = byId("inflight-linger-value");
  if (lingerValue) lingerValue.textContent = `${preferences.completedLingerSeconds}s`;
}

function applyPreferences(preferences, { persist = false, dispatch = true } = {}) {
  state.preferences = normalizePreferences(preferences);
  const root = document.documentElement;
  const effectiveTheme = state.preferences.theme === "system"
    ? (themeMedia.matches ? "router" : "paper")
    : state.preferences.theme;
  const effectiveMotion = state.preferences.motion === "system"
    ? (motionMedia.matches ? "reduced" : "full")
    : state.preferences.motion;
  root.dataset.themeSetting = state.preferences.theme;
  root.dataset.theme = effectiveTheme;
  root.dataset.density = state.preferences.density;
  root.dataset.motionSetting = state.preferences.motion;
  root.dataset.motion = effectiveMotion;
  root.dataset.railSide = state.preferences.inflightPlacement === "right" ? "right" : "left";
  root.dataset.inflightPlacement = state.preferences.inflightPlacement;
  root.dataset.accent = state.preferences.accent ? "custom" : "theme";
  root.style.setProperty("--glow-multiplier", String(state.preferences.glow / 50));
  root.style.colorScheme = effectiveTheme === "paper" ? "light" : "dark";
  if (state.preferences.accent) {
    const hex = state.preferences.accent;
    const red = parseInt(hex.slice(1, 3), 16);
    const green = parseInt(hex.slice(3, 5), 16);
    const blue = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    const shift = luminance > 0.62 ? -28 : 32;
    const hover = [red, green, blue].map((channel) => Math.max(0, Math.min(255, channel + shift)).toString(16).padStart(2, "0")).join("");
    root.style.setProperty("--acid", hex);
    root.style.setProperty("--acid-rgb", `${red}, ${green}, ${blue}`);
    root.style.setProperty("--acid-ink", luminance > 0.56 ? "#11150d" : "#ffffff");
    root.style.setProperty("--acid-hover", `#${hover}`);
  } else {
    for (const property of ["--acid", "--acid-rgb", "--acid-ink", "--acid-hover"]) root.style.removeProperty(property);
  }
  if (persist) {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
    } catch {}
  }
  syncPreferenceControls();
  applyInflightPlacement(state.preferences.inflightPlacement);
  if (dispatch) document.documentElement.dispatchEvent(new CustomEvent("routetok:preferenceschange", {
    bubbles: true,
    detail: { ...state.preferences, effectiveTheme, effectiveMotion }
  }));
}

function updatePreference(key, value) {
  applyPreferences({ ...state.preferences, [key]: value }, { persist: true });
  if (key !== "glow") {
    const status = byId("customize-status");
    if (status) status.textContent = `${key} updated.`;
  }
}

applyPreferences(readStoredJson(localStorage, PREFERENCES_KEY), { dispatch: false });
document.documentElement.classList.toggle("focus-mode", sessionStorage.getItem(FOCUS_MODE_KEY) === "true");

function headers(json = false) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(state.token ? { "x-dashboard-token": state.token } : {})
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) }
  });
  if (response.status === 401) {
    byId("auth-dialog").showModal();
    throw new Error("Dashboard authentication required");
  }
  const payload = await response.json();
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const error = new Error(message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function audioFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(false), ...(options.headers || {}) }
  });
  if (response.status === 401) {
    byId("auth-dialog").showModal();
    throw new Error("Dashboard authentication required");
  }
  if (!response.ok) {
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("json") ? await response.json().catch(() => null) : null;
    const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message;
    const error = new Error(message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

const SANDBOX_DB_NAME = "agentrouter-sandbox-catalog";
const SANDBOX_DB_VERSION = 1;
let sandboxDbPromise;

function sandboxDb() {
  if (sandboxDbPromise) return sandboxDbPromise;
  sandboxDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SANDBOX_DB_NAME, SANDBOX_DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("runs", { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
      store.createIndex("mode", "mode");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return sandboxDbPromise;
}

async function sandboxStore(mode, callback) {
  const db = await sandboxDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("runs", mode);
    const request = callback(transaction.objectStore("runs"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function persistArenaWorkspaces() {
  const workspaces = {};
  for (const mode of ARENA_MODES) {
    const workspace = state.arenaWorkspaces[mode];
    workspaces[mode] = {
      runId: workspace.runId,
      draft: workspace.draft,
      selectedModels: [...workspace.selectedModels],
      modelLineup: [...workspace.modelLineup],
      parameters: workspace.parameters,
      scrollTop: workspace.scrollTop,
      userScrolled: workspace.userScrolled,
      status: workspace.status,
      intent: workspace.intent
    };
  }
  try {
    localStorage.setItem(ARENA_WORKSPACES_KEY, JSON.stringify({ version: 3, activeMode: state.sandboxMode, workspaces }));
  } catch {}
  renderArenaStatus();
}

async function saveSandboxRun(workspace = activeWorkspace(), force = false) {
  if (!force && !workspace.turns.length && !workspace.assistantPlan && !workspace.configProposal) return;
  workspace.saveState = "saving";
  if (workspace === activeWorkspace()) renderArenaStatus();
  const existing = await sandboxStore("readonly", (store) => store.get(workspace.runId)).catch(() => null);
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 2,
    id: workspace.runId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    mode: workspace.mode,
    models: workspaceModelLanes(workspace).map((lane) => lane.model),
    modelLineup: [...workspace.modelLineup],
    parameters: structuredClone(workspace.parameters),
    draft: workspace.draft,
    assistantPlan: workspace.assistantPlan ? structuredClone(workspace.assistantPlan) : null,
    configProposal: workspace.configProposal ? structuredClone(workspace.configProposal) : null,
    turns: structuredClone(workspace.turns)
  };
  try {
    await sandboxStore("readwrite", (store) => store.put(record));
    const runs = await sandboxStore("readonly", (store) => store.getAll());
    for (const stale of runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(100)) {
      await sandboxStore("readwrite", (store) => store.delete(stale.id));
    }
    workspace.saveState = "saved";
  } catch (error) {
    workspace.saveState = "failed";
    throw error;
  } finally {
    persistArenaWorkspaces();
  }
}

async function listSandboxRuns() {
  const runs = await sandboxStore("readonly", (store) => store.getAll());
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function resetChatMessages(message = "Choose up to four models. Prompts are sent to their providers. Assistant mode shares operational metadata, never request bodies or credentials. Results and designs are saved locally in this browser.") {
  const container = byId("chat-messages");
  const proposalHost = byId("config-proposal-host") || document.createElement("section");
  container.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "chat-empty";
  empty.textContent = message;
  proposalHost.id = "config-proposal-host";
  proposalHost.className = "config-proposal-host";
  proposalHost.setAttribute("aria-live", "polite");
  container.append(empty, proposalHost);
}

function readGenerationControls(workspace = activeWorkspace()) {
  workspace.parameters = {
    providerDefaultMax: byId("sandbox-provider-default-max").checked,
    maxTokens: Number(byId("sandbox-max-tokens").value) || 4096,
    temperature: byId("sandbox-temperature").value.trim(),
    topP: byId("sandbox-top-p").value.trim()
  };
}

function applyGenerationControls(workspace) {
  const parameters = workspace.parameters || {};
  byId("sandbox-provider-default-max").checked = parameters.providerDefaultMax === true;
  byId("sandbox-max-tokens").disabled = parameters.providerDefaultMax === true;
  byId("sandbox-max-tokens").value = parameters.maxTokens || 4096;
  byId("sandbox-temperature").value = parameters.temperature ?? "";
  byId("sandbox-top-p").value = parameters.topP ?? "";
}

function workspaceStatus(workspace) {
  if (workspace.busy) return "RUNNING";
  if (workspace.status === "failed") return "FAILED";
  if (workspace.draft) return "DRAFT";
  if (workspace.turns.length || workspace.assistantPlan || workspace.configProposal) return "COMPLETE";
  return "READY";
}

function renderArenaStatus() {
  const workspace = activeWorkspace();
  if (workspace.intent === "compare") workspace.intent = "auto";
  for (const mode of ARENA_MODES) {
    const target = document.querySelector(`[data-mode-status="${mode}"]`);
    if (target) {
      const status = workspaceStatus(state.arenaWorkspaces[mode]);
      target.textContent = status;
      target.dataset.status = status.toLowerCase();
    }
  }
  const label = workspace.mode === "diagnose" ? "SUPPORT" : workspace.mode.toUpperCase();
  byId("arena-title").textContent = `${label} WORKSTREAM`;
  byId("arena-save-state").textContent = workspace.saveState === "saving" ? "LOCAL / SAVING" : workspace.saveState === "failed" ? "LOCAL SAVE FAILED" : workspace.draft ? "LOCAL / DRAFT SAVED" : workspace.turns.length || workspace.assistantPlan || workspace.configProposal ? "LOCAL / SAVED" : "LOCAL / READY";
  const lanes = workspaceModelLanes(workspace);
  byId("arena-model-summary").textContent = lanes.length ? lanes.map((lane) => `${lane.index + 1}. ${lane.model}`).join("  ") : "SELECT LINEUP";
  byId("arena-model-lock").classList.toggle("hidden", !workspace.turns.length);
  byId("agent-intents").classList.toggle("hidden", workspace.mode !== "diagnose");
  byId("propose-config").hidden = workspace.mode !== "diagnose" || !["configure", "optimize"].includes(workspace.intent);
  const intentDescriptions = {
    auto: "Detect the appropriate safe workflow from your request.",
    diagnose: "Analyze bounded live evidence and recommend next checks.",
    explain: "Explain routing, fallback, health, models, or configuration without changing anything.",
    onboard: "Teach setup, APIs, providers, speech, and normal RouteTok workflows.",
    optimize: "Generate an editable optimization proposal; nothing is applied automatically.",
    configure: "Generate an editable configuration proposal that requires validation and confirmation."
  };
  byId("agent-intent-help").textContent = intentDescriptions[workspace.intent] || intentDescriptions.auto;
  if (workspace.mode === "diagnose") {
    const actionLabels = { auto: "ASK", diagnose: "ANALYZE", explain: "EXPLAIN", onboard: "GUIDE", optimize: "PROPOSE", configure: "PROPOSE" };
    const placeholders = {
      auto: "Ask naturally; Support will choose diagnosis, explanation, onboarding, or a proposal workflow...",
      diagnose: "Describe symptoms or unexpected router behavior...",
      explain: "Ask why a request took a route or how a RouteTok feature works...",
      onboard: "Ask how to set up, use, or understand RouteTok...",
      optimize: "Describe the reliability, latency, or cost objective...",
      configure: "Describe the exact configuration change to propose..."
    };
    byId("send-chat").textContent = actionLabels[workspace.intent] || "ASK";
    byId("chat-input").placeholder = placeholders[workspace.intent] || placeholders.auto;
  }
  for (const chip of document.querySelectorAll("[data-agent-intent]")) {
    const active = chip.dataset.agentIntent === workspace.intent;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
}

function renderActiveWorkspace() {
  const workspace = activeWorkspace();
  for (const pending of workspace.pendingCards.values()) if (pending.card?._progressTimer) clearInterval(pending.card._progressTimer);
  workspace.pendingCards.clear();
  resetChatMessages(workspace.mode === "diagnose" ? "Choose a Support intent, then ask about this router. Operational context excludes request bodies and credentials." : undefined);
  byId("chat-messages").querySelector(".chat-empty")?.remove();
  workspace.turns.forEach((turn, index) => renderSandboxTurn(turn.prompt, Object.values(turn.results || {}), turn.mode || workspace.mode, index));
  if (workspace.inflight) renderInflightWorkspace(workspace);
  if (workspace.assistantPlan) renderAssistantPlan(workspace.assistantPlan);
  if (workspace.configProposal) renderConfigProposal(workspace.configProposal, workspace);
  if (!workspace.turns.length && !workspace.inflight && !workspace.assistantPlan && !workspace.configProposal) {
    resetChatMessages(workspace.mode === "diagnose" ? "Choose a Support intent, then ask about this router. Operational context excludes request bodies and credentials." : undefined);
  }
  applyGenerationControls(workspace);
  byId("chat-input").value = workspace.draft;
  byId("send-chat").disabled = workspace.busy;
  byId("propose-config").disabled = workspace.busy;
  byId("stop-chat").hidden = !workspace.busy;
  renderArenaStatus();
  renderChatModelOptions(state.status?.config || {});
  requestAnimationFrame(() => { byId("chat-messages").scrollTop = workspace.scrollTop; });
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function duration(ms) {
  if (ms === null || ms === undefined) return "--";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function costCny(value) {
  return `CNY ${Number(value || 0).toFixed(4)}`;
}

function costUsd(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [days && `${days}d`, hours && `${hours}h`, `${minutes}m`].filter(Boolean).join(" ");
}

function textCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderMarkdown(text) {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`;
  });

  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = url.trim().replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    return /^(https?:|mailto:|\/|#)/i.test(url.trim())
      ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
  });
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^---+$/gm, "<hr>");
  html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  html = html.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
    if (match.startsWith("<ul>")) return match;
    return "<ol>" + match + "</ol>";
  });

  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";
  html = html.replace(/<p>\s*<(pre|h[1-4]|ul|ol|blockquote|hr)/g, "<$1");
  html = html.replace(/<\/(pre|h[1-4]|ul|ol|blockquote|hr)>\s*<\/p>/g, "</$1>");
  html = html.replace(/<p>\s*<\/p>/g, "");

  return html;
}

function isUserNearBottom(container) {
  const threshold = 80;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

function healthState(health) {
  if (!health) return ["ready", ""];
  if (health.entitlementBlocked) return ["blocked", "blocked"];
  if (health.rateLimitedUntil && new Date(health.rateLimitedUntil).getTime() > Date.now()) {
    return ["rate limited", "rate-limited"];
  }
  return [health.circuitState, health.circuitState];
}

function renderHealth(catalog, metrics, config) {
  const body = byId("health-table");
  body.replaceChildren();
  const aggregate = metrics.byModel || {};
  const healthMap = new Map((metrics.health || []).map((item) => [`${item.protocol}:${item.model}`, item]));
  const activeModels = new Set([
    ...(config.openaiOrder || []),
    ...(config.anthropicOrder || []),
    ...(config.paidOpenRouterFallbackOrder || []),
    ...(config.freeModelOrder || []),
    ...(config.enabledExternalModels || []),
    config.dashboardModel,
    ...(metrics.health || []).filter((item) => item.successes + item.failures + item.inflight > 0).map((item) => item.model),
    ...(metrics.recent || []).flatMap((record) => record.attempts?.map((attempt) => attempt.model) || []),
    ...catalog.models.filter((model) => modelProvider(model) === "agentrouter" && !(config.disabledModels || []).includes(model.id)).map((model) => model.id)
  ]);
  const candidates = catalog.models.filter((entry) => activeModels.has(entry.id));
  renderHealthModelPicker(candidates);
  const hidden = new Set(state.preferences.hiddenDashboardModels);
  const rows = candidates.filter((model) => !hidden.has(model.id)).flatMap((model, modelIndex) => model.protocols.map((protocol, protocolIndex) => {
    const health = healthMap.get(`${protocol}:${model.id}`);
    const stats = aggregate[`${protocol}:${model.id}`] || { attempts: 0, successes: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
    const [stateLabel, stateClass] = healthState(health);
    return { model, protocol, health, stats, stateLabel, stateClass, modelIndex, protocolIndex, successRate: stats.attempts ? stats.successes / stats.attempts : null, tokens: (stats.inputTokens || 0) + (stats.outputTokens || 0), cost: stats.estimatedCostUsd || 0 };
  }));
  const sort = state.preferences.dashboardModelSort;
  const direction = state.preferences.dashboardModelSortDirection === "desc" ? -1 : 1;
  const value = (row) => ({ catalog: row.modelIndex * 10 + row.protocolIndex, name: row.model.id, state: row.stateLabel, success: row.successRate, latency: row.health?.latencyEwmaMs ?? null, attempts: row.stats.attempts, tokens: row.tokens, cost: row.cost })[sort];
  rows.sort((left, right) => {
    const a = value(left); const b = value(right);
    if (a == null && b != null) return 1;
    if (b == null && a != null) return -1;
    const compared = typeof a === "string" ? a.localeCompare(String(b)) : Number(a) - Number(b);
    return compared ? compared * direction : left.model.id.localeCompare(right.model.id) || left.protocol.localeCompare(right.protocol);
  });

  for (const { model, protocol, health, stats, stateLabel, stateClass, successRate } of rows) {
      const row = document.createElement("tr");
      textCell(row, model.id, "model-name");
      textCell(row, protocol, "wire");
      const stateCell = textCell(row, "");
      const pill = document.createElement("span");
      pill.className = `status-pill ${stateClass}`;
      pill.textContent = stateLabel;
      stateCell.append(pill);
      textCell(row, successRate == null ? "--" : `${Math.round(successRate * 100)}%`, stats.attempts && stats.successes === 0 ? "failed" : "");
      textCell(row, duration(health?.latencyEwmaMs), "muted");
      textCell(row, String(health?.inflight || 0), health?.inflight ? "live-value" : "muted");
      textCell(row, String(stats.attempts || 0), "muted");
      textCell(row, `${compactNumber(stats.inputTokens || 0)} / ${compactNumber(stats.outputTokens || 0)}`, "muted");
      textCell(row, `${compactNumber(stats.cacheReadTokens || 0)} / ${compactNumber(stats.cacheWriteTokens || 0)}`, "muted");
      textCell(row, costUsd(stats.estimatedCostUsd || 0), "muted");
      body.append(row);
  }
  if (!rows.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td");
    cell.colSpan = 10; cell.className = "table-empty"; cell.textContent = candidates.length ? "NO DASHBOARD MODELS SELECTED" : "NO ACTIVE MODELS";
    row.append(cell); body.append(row);
  }
}

function renderHealthModelPicker(models) {
  const options = byId("health-model-options");
  if (!options) return;
  const signature = models.map((model) => `${model.id}:${model.displayName || ""}`).join("|");
  const hidden = new Set(state.preferences.hiddenDashboardModels);
  if (state.healthPickerSignature !== signature) {
    state.healthPickerSignature = signature;
    options.replaceChildren();
    for (const model of models) {
      const label = document.createElement("label"); const checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.value = model.id; checkbox.checked = !hidden.has(model.id); checkbox.dataset.healthModel = model.id;
      label.append(checkbox, document.createTextNode(model.displayName || model.id)); options.append(label);
    }
  } else {
    options.querySelectorAll("[data-health-model]").forEach((checkbox) => { checkbox.checked = !hidden.has(checkbox.dataset.healthModel); });
  }
  byId("health-model-count").textContent = `${models.filter((model) => !hidden.has(model.id)).length} / ${models.length} MODELS`;
}

function renderRecent(records) {
  const signature = records.slice(0, 50).map((record) => [
    record.id,
    record.status,
    record.durationMs,
    record.usage.output,
    record.attempts.length
  ].join(":")).join("|");
  if (signature === state.recentSignature) return;
  state.recentSignature = signature;
  const list = byId("request-list");
  list.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "request-empty";
    empty.textContent = "NO REQUESTS RECORDED";
    list.append(empty);
    return;
  }

  for (const record of records.slice(0, 50)) {
    const details = document.createElement("details");
    details.className = "request-card";
    details.open = state.expandedRequests.has(record.id);
    details.addEventListener("toggle", () => {
      if (details.open) state.expandedRequests.add(record.id);
      else state.expandedRequests.delete(record.id);
    });

    const summary = document.createElement("summary");
    summary.className = "request-summary";
    const route = record.attempts.map((attempt) => attempt.model).join(" > ") || "--";
    const successful = record.status >= 200 && record.status < 300 && !record.error;
    const tokens = record.usage.input + record.usage.output;

    const summaryValues = [
      ["request-chevron", ""],
      ["request-time", new Date(record.timestamp).toLocaleTimeString([], { hour12: false })],
      ["request-model", record.requestedModel],
      ["request-route", route],
      ["wire", record.protocol],
      [successful ? "successful" : "failed", String(record.status)],
      ["muted", duration(record.durationMs)],
      ["muted", `${compactNumber(tokens)} tok`],
      ["muted", costUsd(record.usage.estimatedCostUsd)]
    ];
    for (const [className, value] of summaryValues) {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = value;
      summary.append(span);
    }

    const clip = document.createElement("div");
    clip.className = "request-detail-clip";
    const detail = document.createElement("div");
    detail.className = "request-detail";
    const stats = document.createElement("div");
    stats.className = "request-stats";
    const statValues = [
      ["TOKENS IN", compactNumber(record.usage.input)],
      ["TOKENS OUT", compactNumber(record.usage.output)],
      ["CACHE READ", compactNumber(record.usage.cacheRead || 0)],
      ["CACHE WRITE", compactNumber(record.usage.cacheWrite || 0)],
      ["TIME TO FIRST TOKEN", duration(record.ttftMs)],
      ["OUTPUT SPEED", record.outputTokensPerSecond == null ? "--" : `${record.outputTokensPerSecond.toFixed(1)} tok/s`],
      ["GENERATION TIME", duration(record.generationDurationMs)],
      ["TOTAL TIME", duration(record.durationMs)],
      ["ESTIMATED COST", costUsd(record.usage.estimatedCostUsd)],
      ["REPORTED BILLING", costCny(record.usage.costCny)]
    ];
    for (const [label, value] of statValues) {
      const stat = document.createElement("div");
      const labelElement = document.createElement("span");
      const valueElement = document.createElement("strong");
      labelElement.textContent = label;
      valueElement.textContent = value;
      stat.append(labelElement, valueElement);
      stats.append(stat);
    }
    detail.append(stats);

    const attempts = document.createElement("div");
    attempts.className = "request-attempts";
    const attemptsTitle = document.createElement("h3");
    attemptsTitle.textContent = "UPSTREAM ATTEMPTS";
    attempts.append(attemptsTitle);
    for (const [index, attempt] of record.attempts.entries()) {
      const item = document.createElement("div");
      item.className = `request-attempt ${attempt.outcome}`;
      const values = [
        `#${index + 1}`,
        attempt.model,
        attempt.status == null ? "NO STATUS" : `HTTP ${attempt.status}`,
        attempt.outcome.replaceAll("_", " "),
        duration(attempt.durationMs),
        attempt.firstOutputMs == null ? "NO OUTPUT" : `FIRST TOKEN ${duration(attempt.firstOutputMs)}`,
        attempt.error || ""
      ];
      for (const value of values) {
        const span = document.createElement("span");
        span.textContent = value;
        item.append(span);
      }
      attempts.append(item);
    }
    if (!record.attempts.length) {
      const none = document.createElement("p");
      none.className = "muted";
      none.textContent = "No upstream attempt was dispatched.";
      attempts.append(none);
    }
    detail.append(attempts);

    if (record.error) {
      const error = document.createElement("p");
      error.className = "request-error";
      error.textContent = record.error;
      detail.append(error);
    }

    const contentDetails = document.createElement("details");
    contentDetails.className = "request-content-details";
    contentDetails.open = state.expandedRequestContent.has(record.id);
    const contentSummary = document.createElement("summary");
    contentSummary.textContent = "REQUEST CONTENT / LOAD ON DEMAND";
    const content = document.createElement("div");
    content.className = "request-content";
    content.dataset.requestContent = record.id;
    contentDetails.append(contentSummary, content);
    const cached = state.requestContent.get(record.id);
    if (cached) renderRequestContent(content, cached);
    contentDetails.addEventListener("toggle", () => {
      if (!contentDetails.open) {
        state.expandedRequestContent.delete(record.id);
        return;
      }
      state.expandedRequestContent.add(record.id);
      if (!state.requestContent.has(record.id)) void loadRequestContent(record.id, content);
    });
    if (contentDetails.open && !cached) void loadRequestContent(record.id, content);
    detail.append(contentDetails);

    clip.append(detail);
    details.append(summary, clip);
    list.append(details);
  }
}

function renderRequestContent(container, value) {
  container.replaceChildren();
  if (value instanceof Error) {
    const message = document.createElement("p");
    message.className = "request-content-error";
    message.textContent = value.message;
    container.append(message);
    return;
  }
  const metadata = document.createElement("p");
  metadata.className = "request-content-meta";
  metadata.textContent = `${compactNumber(value.sizeBytes)} bytes / captured ${new Date(value.capturedAt).toLocaleTimeString()}`;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value.body, null, 2);
  container.append(metadata, pre);
}

async function loadRequestContent(requestId, container) {
  if (state.requestContentLoading.has(requestId)) return;
  state.requestContentLoading.add(requestId);
  container.textContent = "LOADING REQUEST CONTENT...";
  try {
    const payload = await api(`/admin/api/requests/${encodeURIComponent(requestId)}/content`);
    state.requestContent.set(requestId, payload);
    const current = document.querySelector(`[data-request-content="${requestId}"]`);
    if (current) renderRequestContent(current, payload);
  } catch (error) {
    const unavailable = error instanceof Error ? error : new Error(String(error));
    state.requestContent.set(requestId, unavailable);
    const current = document.querySelector(`[data-request-content="${requestId}"]`);
    if (current) renderRequestContent(current, unavailable);
  } finally {
    state.requestContentLoading.delete(requestId);
  }
}

function animateNumber(element, target, formatter, milliseconds = 450) {
  const reducedMotion = document.documentElement.dataset.motion === "reduced";
  const previous = Number(element.dataset.numericValue ?? target);
  element.dataset.numericValue = String(target);
  const existing = state.metricAnimations.get(element);
  if (existing) {
    cancelAnimationFrame(existing);
    state.metricAnimations.delete(element);
  }
  if (reducedMotion || !Number.isFinite(previous) || Math.abs(previous - target) < 0.001) {
    element.textContent = formatter(target);
    return;
  }
  const started = performance.now();
  const tick = (now) => {
    if (!element.isConnected) {
      state.metricAnimations.delete(element);
      return;
    }
    const progress = Math.min(1, (now - started) / milliseconds);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = formatter(previous + (target - previous) * eased);
    if (progress < 1) state.metricAnimations.set(element, requestAnimationFrame(tick));
    else state.metricAnimations.delete(element);
  };
  state.metricAnimations.set(element, requestAnimationFrame(tick));
}

function createLiveVisual(request) {
  const node = document.createElement("article");
  node.className = "live-request is-entering";
  node.dataset.requestId = request.id;
  const activity = document.createElement("i");
  activity.className = "live-activity";
  const model = document.createElement("strong");
  const meta = document.createElement("span");
  const requestId = document.createElement("small");
  requestId.textContent = request.id;
  const rate = document.createElement("strong");
  const tokens = document.createElement("span");
  const track = document.createElement("div");
  track.className = "live-track";
  track.append(document.createElement("i"));
  const elapsed = document.createElement("strong");
  const ttft = document.createElement("span");
  const extra = document.createElement("small");
  node.append(activity, model, meta, rate, tokens, elapsed, ttft, extra, requestId, track);
  return { node, activity, model, meta, rate, tokens, elapsed, ttft, extra, removalTimer: null, exitTimer: null };
}

function updateActiveVisual(visual, request) {
  visual.node.classList.remove("is-complete", "is-failed", "is-leaving");
  visual.node.classList.add("is-active");
  visual.finalized = false;
  visual.activity.className = `live-activity ${request.phase}`;
  visual.model.textContent = request.selectedModel || request.requestedModel;
  const route = request.selectedModel && request.selectedModel !== request.requestedModel ? `${request.requestedModel} -> ${request.selectedModel}` : request.requestedModel;
  visual.meta.textContent = `${request.protocol.toUpperCase()} ${request.path} / ${request.phase.toUpperCase()} / ATTEMPT ${request.attemptCount || 0} / ${request.stream ? "STREAM" : "JSON"} / ${route}`;
  const rate = request.estimatedOutputTokensPerSecond;
  if (rate == null) {
    visual.rate.textContent = "-- tok/s";
    delete visual.rate.dataset.numericValue;
  } else {
    animateNumber(visual.rate, rate, (value) => `${value.toFixed(1)} tok/s`);
  }
  animateNumber(visual.tokens, request.estimatedOutputTokens, (value) => `${value.toFixed(1)} est tok`);
  animateNumber(visual.elapsed, request.durationMs, (value) => duration(value));
  visual.ttft.textContent = request.ttftMs == null ? "TTFT pending" : `TTFT ${duration(request.ttftMs)}`;
  visual.extra.textContent = request.stream ? "ESTIMATE" : "BUFFERING";
}

function completeLiveVisual(requestId, visual, record) {
  if (visual.removalTimer) window.clearTimeout(visual.removalTimer);
  if (visual.exitTimer) window.clearTimeout(visual.exitTimer);
  visual.finalized = Boolean(record);
  visual.node.classList.remove("is-active", "is-leaving");
  visual.node.classList.add("is-complete");
  const successful = record && record.status >= 200 && record.status < 300 && !record.error;
  visual.node.classList.toggle("is-failed", Boolean(record && !successful));
  visual.activity.className = `live-activity ${successful ? "completed" : record ? "failed" : "completed"}`;
  if (record) {
    visual.model.textContent = record.selectedModel || record.requestedModel;
    visual.meta.textContent = `${record.protocol.toUpperCase()} ${record.path} / ${successful ? "COMPLETE" : "FAILED"} / HTTP ${record.status} / ${record.attempts.length} ATTEMPT${record.attempts.length === 1 ? "" : "S"} / ${record.provider || "unknown provider"}`;
    visual.rate.textContent = record.outputTokensPerSecond == null ? "OUTPUT COMPLETE" : `${record.outputTokensPerSecond.toFixed(1)} tok/s exact`;
    visual.tokens.textContent = `${compactNumber(record.usage.output)} out / ${compactNumber(record.usage.input)} in / ${compactNumber((record.usage.cacheRead || 0) + (record.usage.cacheWrite || 0))} cache`;
    visual.elapsed.textContent = duration(record.durationMs);
    visual.ttft.textContent = record.ttftMs == null ? "TTFT unavailable" : `TTFT ${duration(record.ttftMs)}`;
    visual.extra.textContent = `${costUsd(record.usage.estimatedCostUsd)} estimated`;
  } else {
    visual.meta.textContent = "COMPLETED / FINAL METRICS PENDING";
    visual.extra.textContent = "SETTLING";
  }
  visual.removalTimer = window.setTimeout(() => {
    visual.node.classList.add("is-leaving");
    visual.exitTimer = window.setTimeout(() => {
      visual.node.remove();
      state.liveVisuals.delete(requestId);
      if (!state.liveVisuals.size) {
        const empty = document.createElement("p");
        empty.className = "live-empty";
        empty.textContent = "No requests in flight.";
        byId("live-request-list").append(empty);
      }
    }, 650);
  }, (state.preferences?.completedLingerSeconds ?? 4) * 1_000);
}

function renderLiveRequests(requests, completedRecords = []) {
  const list = byId("live-request-list");
  const activeIds = new Set(requests.map((request) => request.id));
  list.querySelector(".live-empty")?.remove();
  for (const request of requests) {
    let visual = state.liveVisuals.get(request.id);
    if (!visual) {
      visual = createLiveVisual(request);
      state.liveVisuals.set(request.id, visual);
      list.prepend(visual.node);
      requestAnimationFrame(() => visual.node.classList.remove("is-entering"));
    }
    if (visual.removalTimer) window.clearTimeout(visual.removalTimer);
    if (visual.exitTimer) window.clearTimeout(visual.exitTimer);
    visual.removalTimer = null;
    visual.exitTimer = null;
    updateActiveVisual(visual, request);
  }

  const completedById = new Map(completedRecords.map((record) => [record.id, record]));
  for (const [requestId, visual] of state.liveVisuals) {
    if (activeIds.has(requestId)) continue;
    const record = completedById.get(requestId);
    if (record && !visual.finalized) {
      completeLiveVisual(requestId, visual, record);
      continue;
    }
    if (visual.removalTimer || visual.node.classList.contains("is-leaving")) continue;
    completeLiveVisual(requestId, visual, record);
  }
  if (!state.liveVisuals.size) {
    const empty = document.createElement("p");
    empty.className = "live-empty";
    empty.textContent = "No requests in flight.";
    list.append(empty);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_COLORS = {
  acid: "#c5f459",
  cyan: "#58d9c7",
  amber: "#ffbd59",
  red: "#ff6b5f",
  violet: "#aa8cff",
  grid: "#293129",
  muted: "#858b82"
};

function refreshChartColors() {
  const styles = getComputedStyle(document.documentElement);
  for (const color of Object.keys(CHART_COLORS)) {
    const property = color === "grid" ? "--line" : `--${color}`;
    const value = styles.getPropertyValue(property).trim();
    if (value) CHART_COLORS[color] = value;
  }
}

function svgNode(name, attributes = {}, text = "") {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  return node;
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function historyBuckets(samples, maximumBuckets = 80) {
  if (!samples.length) return [];
  const size = Math.max(1, Math.ceil(samples.length / maximumBuckets));
  const buckets = [];
  for (let index = 0; index < samples.length; index += size) {
    const group = samples.slice(index, index + size);
    const sum = (key) => group.reduce((total, sample) => total + (Number(sample[key]) || 0), 0);
    const successCount = group.filter((sample) => sample.success).length;
    buckets.push({
      timestamp: group.at(-1).timestamp,
      requests: group.length,
      throughput: average(group.map((sample) => sample.outputTokensPerSecond)),
      latency: average(group.map((sample) => sample.durationMs)),
      ttft: average(group.map((sample) => sample.ttftMs)),
      input: sum("inputTokens"),
      output: sum("outputTokens"),
      cache: sum("cacheReadTokens") + sum("cacheWriteTokens"),
      cost: sum("estimatedCostUsd"),
      successRate: successCount / group.length * 100,
      failureRate: (group.length - successCount) / group.length * 100
    });
  }
  return buckets;
}

function renderLineChart(id, buckets, series, options = {}) {
  const svg = byId(id);
  svg.replaceChildren();
  const width = svg.viewBox.baseVal.width || 640;
  const height = svg.viewBox.baseVal.height || 220;
  const margin = { top: 16, right: 14, bottom: 28, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = buckets.flatMap((bucket) => series.map((line) => line.value(bucket)))
    .filter((value) => Number.isFinite(value));
  const maximum = options.maximum || Math.max(0, ...values);
  const yMaximum = maximum > 0 ? maximum * (options.maximum ? 1 : 1.08) : 1;
  const format = options.format || compactNumber;

  for (let step = 0; step <= 4; step += 1) {
    const y = margin.top + plotHeight * step / 4;
    svg.append(svgNode("line", { x1: margin.left, y1: y, x2: width - margin.right, y2: y, stroke: CHART_COLORS.grid, "stroke-width": 1 }));
    svg.append(svgNode("text", {
      x: margin.left - 8,
      y: y + 3,
      fill: CHART_COLORS.muted,
      "font-size": 9,
      "text-anchor": "end",
      "font-family": "monospace"
    }, format(yMaximum * (1 - step / 4))));
  }

  if (!buckets.length || !values.length) {
    svg.append(svgNode("text", {
      x: width / 2,
      y: height / 2,
      fill: CHART_COLORS.muted,
      "font-size": 11,
      "text-anchor": "middle",
      "font-family": "monospace"
    }, "NO HISTORICAL DATA YET"));
    return;
  }

  const xFor = (index) => margin.left + (buckets.length === 1 ? plotWidth / 2 : index / (buckets.length - 1) * plotWidth);
  const yFor = (value) => margin.top + plotHeight - Math.min(value, yMaximum) / yMaximum * plotHeight;
  for (const line of series) {
    let path = "";
    let drawing = false;
    buckets.forEach((bucket, index) => {
      const value = line.value(bucket);
      if (!Number.isFinite(value)) {
        drawing = false;
        return;
      }
      path += `${drawing ? " L" : " M"} ${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}`;
      drawing = true;
    });
    if (path) svg.append(svgNode("path", {
      d: path.trim(),
      fill: "none",
      stroke: line.color,
      "stroke-width": line.width || 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      pathLength: 1,
      "vector-effect": "non-scaling-stroke"
    }));
  }

  const start = new Date(buckets[0].timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const end = new Date(buckets.at(-1).timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  svg.append(svgNode("text", { x: margin.left, y: height - 7, fill: CHART_COLORS.muted, "font-size": 9, "font-family": "monospace" }, start));
  svg.append(svgNode("text", { x: width - margin.right, y: height - 7, fill: CHART_COLORS.muted, "font-size": 9, "text-anchor": "end", "font-family": "monospace" }, end));
}

function renderHistory() {
  refreshChartColors();
  const selected = Number(byId("history-range").value || 500);
  const samples = state.historySamples.slice(-selected);
  const buckets = historyBuckets(samples);
  const exactRates = samples.map((sample) => sample.outputTokensPerSecond).filter(Number.isFinite);
  const exactAverage = average(exactRates);
  const exactPeak = exactRates.length ? Math.max(...exactRates) : null;
  const averageLatency = average(samples.map((sample) => sample.durationMs));
  const averageTtft = average(samples.map((sample) => sample.ttftMs));
  const tokenTotal = samples.reduce((total, sample) => total + sample.inputTokens + sample.outputTokens, 0);
  const spend = samples.reduce((total, sample) => total + sample.estimatedCostUsd, 0);
  const successes = samples.filter((sample) => sample.success).length;
  const successRate = samples.length ? successes / samples.length * 100 : null;

  byId("history-retained").textContent = `${compactNumber(state.historyRetained)} SAMPLES RETAINED`;
  byId("throughput-chart-value").textContent = exactAverage == null ? "--" : `${exactAverage.toFixed(1)} avg / ${exactPeak.toFixed(1)} peak`;
  byId("latency-chart-value").textContent = averageLatency == null ? "--" : `${duration(averageLatency)} avg / ${duration(averageTtft)} TTFT`;
  byId("tokens-chart-value").textContent = `${compactNumber(tokenTotal)} reported`;
  byId("cost-chart-value").textContent = costUsd(spend);
  byId("success-chart-value").textContent = successRate == null ? "--" : `${successRate.toFixed(1)}% / ${samples.length - successes} failed`;

  renderLineChart("throughput-chart", buckets, [
    { value: (bucket) => bucket.throughput, color: CHART_COLORS.cyan, width: 2.4 }
  ], { format: (value) => `${compactNumber(value)}` });
  renderLineChart("latency-chart", buckets, [
    { value: (bucket) => bucket.latency, color: CHART_COLORS.acid, width: 2.2 },
    { value: (bucket) => bucket.ttft, color: CHART_COLORS.amber, width: 1.8 }
  ], { format: (value) => duration(value) });
  renderLineChart("tokens-chart", buckets, [
    { value: (bucket) => bucket.input, color: CHART_COLORS.acid, width: 2 },
    { value: (bucket) => bucket.output, color: CHART_COLORS.cyan, width: 2 },
    { value: (bucket) => bucket.cache, color: CHART_COLORS.violet, width: 1.6 }
  ]);
  renderLineChart("cost-chart", buckets, [
    { value: (bucket) => bucket.cost, color: CHART_COLORS.amber, width: 2.2 }
  ], { format: (value) => `$${Number(value).toFixed(value < 0.01 ? 4 : 2)}` });
  renderLineChart("success-chart", buckets, [
    { value: (bucket) => bucket.successRate, color: CHART_COLORS.acid, width: 2.2 },
    { value: (bucket) => bucket.failureRate, color: CHART_COLORS.red, width: 1.8 }
  ], { maximum: 100, format: (value) => `${Math.round(value)}%` });
}

async function loadHistory(force = false) {
  if (state.historyUnavailable) return;
  const now = Date.now();
  if (!force && now - state.historyLastFetch < 5_000) return;
  state.historyLastFetch = now;
  try {
    const payload = await api("/admin/api/history?limit=5000");
    state.historySamples = payload.samples || [];
    state.historyRetained = payload.retained || state.historySamples.length;
    state.historyRequestCount = state.status?.metrics?.totals?.requests ?? null;
    renderHistory();
  } catch (error) {
    if (error.status === 404) {
      state.historyUnavailable = true;
      byId("history-retained").textContent = "HISTORY API UNAVAILABLE / RESTART REQUIRED";
      renderHistory();
      return;
    }
    if (force) notify(error.message);
  }
}

function fillConfig(config) {
  for (const id of [
    "maxAttempts",
    "requestTimeoutMs",
    "firstEventTimeoutMs",
    "slowModelFirstEventTimeoutMs",
    "streamIdleTimeoutMs",
    "circuitFailureThreshold",
    "circuitOpenMs",
    "circuitWindowSize",
    "circuitMinimumSamples",
    "catalogRefreshHours"
  ]) byId(id).value = config[id];
  byId("fallbackExplicitModels").checked = config.fallbackExplicitModels;
  byId("thinkingFallbackMode").value = config.thinkingFallbackMode;
  state.configDraft = {
    openaiOrder: [...(config.openaiOrder || [])],
    anthropicOrder: [...(config.anthropicOrder || [])],
    paidOpenRouterFallbackOrder: [...(config.paidOpenRouterFallbackOrder || [])],
    freeModelOrder: [...(config.freeModelOrder || [])],
    disabledModels: [...(config.disabledModels || [])],
    enabledExternalModels: [...(config.enabledExternalModels || [])],
    customCascades: structuredClone(config.customCascades || [])
  };
  syncDraftInputs();
  if (state.configOpen) renderModelManager();
}

function renderChatModelOptions(config) {
  const container = byId("chat-model-options");
  if (!container) return;
  const disabled = new Set(config.disabledModels || []);
  const configuredProviders = new Set((state.status?.providers || []).filter((provider) => provider.configured).map((provider) => provider.providerId));
  const models = catalogModels().filter((model) => {
    if (disabled.has(model.id) || !isTextGenerationModel(model)) return false;
    const provider = modelProvider(model);
    if (!configuredProviders.has(provider)) return false;
    return provider === "agentrouter" || isFreeExternalModel(model) || (config.enabledExternalModels || []).includes(model.id);
  });
  if (!state.sandboxSelectedModels.size && !activeWorkspace()._defaultsLoaded) {
    activeWorkspace()._defaultsLoaded = true;
    const stored = readStoredJson(localStorage, SANDBOX_MODELS_KEY);
    for (const id of Array.isArray(stored) ? stored : config.openaiOrder?.slice(0, 2) || []) {
      if (models.some((model) => model.id === id) && state.sandboxSelectedModels.size < 4) state.sandboxSelectedModels.add(id);
    }
  }
  for (const id of [...state.sandboxSelectedModels]) if (!models.some((model) => model.id === id)) state.sandboxSelectedModels.delete(id);
  const signature = JSON.stringify({
    models: models.map((model) => model.id),
    selected: [...state.sandboxSelectedModels],
    locked: state.chatBusy || state.chatTurns.length > 0
  });
  if (signature === state.sandboxModelSignature) {
    const laneCount = workspaceModelLanes().length;
    byId("chat-model-count").textContent = `${laneCount} / 4 LANES${laneCount !== state.sandboxSelectedModels.size ? ` · ${state.sandboxSelectedModels.size} MODEL` : ""}`;
    if (state.chatBusy) byId("chat-route").textContent = `${laneCount} RUNNING`;
    else if (!state.chatTurns.length) byId("chat-route").textContent = `${laneCount} READY`;
    renderArenaStatus();
    return;
  }
  state.sandboxModelSignature = signature;
  container.replaceChildren();
  for (const model of models) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = model.id;
    checkbox.checked = state.sandboxSelectedModels.has(model.id);
    checkbox.disabled = state.chatBusy || state.chatTurns.length > 0;
    const text = document.createElement("span");
    text.textContent = `${model.displayName || model.id} / ${modelProvider(model)}`;
    label.append(checkbox, text);
    container.append(label);
  }
  const laneCount = workspaceModelLanes().length;
  byId("chat-model-count").textContent = `${laneCount} / 4 LANES${laneCount !== state.sandboxSelectedModels.size ? ` · ${state.sandboxSelectedModels.size} MODEL` : ""}`;
  if (state.chatBusy) byId("chat-route").textContent = `${laneCount} RUNNING`;
  else if (!state.chatTurns.length) byId("chat-route").textContent = `${laneCount} READY`;
  renderArenaStatus();
}

function syncDraftInputs() {
  if (!state.configDraft) return;
  byId("openaiOrder").value = state.configDraft.openaiOrder.join("\n");
  byId("anthropicOrder").value = state.configDraft.anthropicOrder.join("\n");
  byId("paidOpenRouterFallbackOrder").value = state.configDraft.paidOpenRouterFallbackOrder.join("\n");
  byId("freeModelOrder").value = state.configDraft.freeModelOrder.join("\n");
  byId("disabledModels").value = state.configDraft.disabledModels.join("\n");
  byId("enabledExternalModels").value = state.configDraft.enabledExternalModels.join("\n");
}

function catalogModels() {
  return Array.isArray(state.status?.catalog?.models) ? state.status.catalog.models : [];
}

function catalogProviders() {
  const catalogStates = Array.isArray(state.status?.catalog?.providers) ? state.status.catalog.providers : [];
  const runtimeStates = Array.isArray(state.status?.providers) ? state.status.providers : [];
  const inferred = new Map();
  for (const provider of [...runtimeStates, ...catalogStates]) {
    const id = provider.providerId || provider.id;
    if (!id) continue;
    inferred.set(id, {
      ...(inferred.get(id) || {}),
      ...provider,
      id,
      name: provider.name || id.charAt(0).toUpperCase() + id.slice(1),
      connectionState: provider.connected === true ? "connected" : provider.lastError ? "degraded" : provider.configured === false ? "not configured" : "unknown",
      catalogState: provider.source || provider.catalogState || "unknown"
    });
  }
  for (const model of catalogModels()) {
    const id = model.providerId || "agentrouter";
    if (!inferred.has(id)) inferred.set(id, { id, name: id.charAt(0).toUpperCase() + id.slice(1), modelCount: 0 });
    const provider = inferred.get(id);
    if (provider.modelCount === undefined) provider.modelCount = 0;
    if (!catalogStates.some((state) => (state.providerId || state.id) === id)) provider.modelCount += 1;
  }
  return [...inferred.values()];
}

function unknown(value, formatter = String) {
  return value === null || value === undefined || value === "" ? "--" : formatter(value);
}

function modelProvider(model) {
  return model.providerId || model.source || "unknown";
}

function modelSupports(model, protocol) {
  return (model.protocols || []).some((wire) => String(wire).toLowerCase() === protocol);
}

function isExternalModel(model) {
  return modelProvider(model) !== "agentrouter";
}

function isFreeExternalModel(model) {
  if (!isExternalModel(model) || modelPrice(model, "input") !== 0 || modelPrice(model, "output") !== 0) return false;
  if (modelProvider(model) !== "openrouter") return true;
  return model.upstreamId === "openrouter/free" || String(model.upstreamId || "").endsWith(":free");
}

function isTextGenerationModel(model) {
  if (!modelSupports(model, "openai") || (model.endpoints && !model.endpoints.includes("chat"))) return false;
  if (model.inputModalities?.length && !model.inputModalities.includes("text")) return false;
  if (model.outputModalities?.length && (model.outputModalities.length !== 1 || model.outputModalities[0] !== "text")) return false;
  if (modelProvider(model) === "openrouter" && model.supportedParameters?.length) {
    return model.supportedParameters.some((parameter) => ["max_tokens", "temperature", "top_p", "tools", "reasoning"].includes(parameter));
  }
  return true;
}

function isModelEnabled(model) {
  if (!state.configDraft || state.configDraft.disabledModels.includes(model.id)) return false;
  if (!isExternalModel(model) || isFreeExternalModel(model)) return true;
  return state.configDraft.enabledExternalModels.includes(model.id);
}

function setDraftDirty() {
  state.configDirty = true;
  syncDraftInputs();
}

function priceText(value, currency) {
  if (value === null || value === undefined) return "--";
  return `${currency || "USD"} ${Number(value).toFixed(Number(value) < 1 ? 3 : 2)}`;
}

function modelPrice(model, type) {
  const pricing = model.pricing || {};
  const aliases = {
    input: ["inputPerMillion", "input"],
    output: ["outputPerMillion", "output"],
    cacheRead: ["cacheReadPerMillion", "cacheRead"],
    cacheWrite: ["cacheWritePerMillion", "cacheWrite"]
  }[type] || [type];
  for (const key of aliases) if (pricing[key] !== null && pricing[key] !== undefined) return pricing[key];
  return null;
}

function modelCapabilityTags(model) {
  if (Array.isArray(model.capabilities)) return model.capabilities;
  if (!model.capabilities || typeof model.capabilities !== "object") return [];
  return Object.entries(model.capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name);
}

function providerStatusValue(provider, ...keys) {
  for (const key of keys) if (provider[key] !== null && provider[key] !== undefined && provider[key] !== "") return provider[key];
  return null;
}

function renderProviderCards() {
  const container = byId("provider-cards");
  if (!container) return;
  container.replaceChildren();
  const providers = catalogProviders().filter((provider) => provider.configured !== false);
  for (const provider of providers) {
    const id = String(provider.id || provider.name || "unknown");
    const card = document.createElement("article");
    card.className = "provider-card";
    const header = document.createElement("header");
    const title = document.createElement("h4");
    title.textContent = provider.name || id;
    const configured = document.createElement("span");
    configured.className = "status-pill";
    configured.textContent = provider.configured === true ? "CONFIGURED" : provider.configured === false ? "NOT CONFIGURED" : "NOT REPORTED";
    header.append(title, configured);
    const creditText = provider.credits?.error
      ? `ERROR: ${provider.credits.error}${provider.credits?.remainingUsd != null ? ` / last known ${costUsd(provider.credits.remainingUsd)}` : ""}`
      : provider.credits?.remainingUsd != null ? `${costUsd(provider.credits.remainingUsd)} remaining`
        : provider.credits?.balanceUsd != null ? `${costUsd(provider.credits.balanceUsd)} balance`
          : provider.credits?.supported === false ? "NOT SUPPORTED" : provider.credits?.fetchedAt ? "NO BALANCE REPORTED" : "NOT CHECKED";
    const values = [
      ["CATALOG STATUS", provider.lastError ? "ERROR" : provider.connected === true ? "READY" : provider.configured === false ? "NOT CONFIGURED" : provider.lastAttempt ? "UNAVAILABLE" : "NOT CHECKED"],
      ["CATALOG SOURCE", providerStatusValue(provider, "source", "catalogState", "catalog", "state")],
      ["MODELS", providerStatusValue(provider, "modelCount")],
      ["LAST ATTEMPT", provider.lastAttempt ? new Date(provider.lastAttempt).toLocaleString() : null],
      ["LAST SUCCESS", provider.lastRefresh ? new Date(provider.lastRefresh).toLocaleString() : null],
      ["CREDITS", creditText]
    ];
    const list = document.createElement("dl");
    for (const [label, value] of values) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value === null ? "NOT REPORTED" : String(value);
      list.append(dt, dd);
    }
    if (provider.lastError) {
      const error = document.createElement("dd");
      error.className = "provider-error";
      error.textContent = `CATALOG ERROR: ${provider.lastError}`;
      list.append(error);
    }
    const actions = document.createElement("div");
    actions.className = "provider-actions";
    for (const [label, action] of [["REFRESH CATALOG", "catalog"], ["REFRESH CREDITS", "credits"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button secondary";
      button.textContent = label;
      button.dataset.providerAction = action;
      button.dataset.providerId = id;
      actions.append(button);
    }
    card.append(header, list, actions);
    container.append(card);
  }
  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No configured provider status is available.";
    container.append(empty);
  }
}

function renderApiKeyManager() {
  const container = byId("api-key-manager");
  container.replaceChildren();
  for (const provider of state.status?.providers || []) {
    for (const field of ["apiKey", ...(provider.providerId === "openrouter" ? ["managementKey"] : [])]) {
      const status = provider.credentials?.[field] || { configured: false, source: "unset" };
      const row = document.createElement("section");
      row.className = "api-key-row";
      const identity = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${provider.providerId} / ${field === "managementKey" ? "management key" : "API key"}`;
      const source = document.createElement("small");
      source.textContent = `${status.configured ? "CONFIGURED" : "NOT CONFIGURED"} / ${String(status.source).toUpperCase()}`;
      identity.append(title, source);
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "new-password";
      input.placeholder = "Enter replacement key";
      input.dataset.credentialInput = `${provider.providerId}:${field}`;
      input.setAttribute("aria-label", `${provider.providerId} ${field}`);
      const update = document.createElement("button");
      update.type = "button";
      update.className = "button primary-button";
      update.dataset.credentialUpdate = `${provider.providerId}:${field}`;
      update.textContent = "UPDATE";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button secondary";
      remove.dataset.credentialDelete = `${provider.providerId}:${field}`;
      remove.textContent = "DELETE";
      row.append(identity, input, update, remove);
      container.append(row);
    }
  }
}

function filteredModels() {
  const text = (byId("model-search")?.value || "").trim().toLowerCase();
  const provider = byId("model-provider-filter")?.value || "all";
  const protocol = byId("model-protocol-filter")?.value || "all";
  const modality = byId("model-modality-filter")?.value || "all";
  const enabledState = byId("model-state-filter")?.value || "all";
  const order = byId("model-order-filter")?.value || "all";
  const freeOnly = byId("model-free-only")?.checked === true;
  const priceBasis = byId("model-price-basis")?.value === "output" ? "output" : "input";
  const minText = byId("model-price-min")?.value.trim() || "";
  const maxText = byId("model-price-max")?.value.trim() || "";
  const minimumPrice = minText === "" ? null : Number(minText);
  const maximumPrice = maxText === "" ? null : Number(maxText);
  const openai = new Set(state.configDraft?.openaiOrder || []);
  const anthropic = new Set(state.configDraft?.anthropicOrder || []);
  const paidOpenRouter = new Set(state.configDraft?.paidOpenRouterFallbackOrder || []);
  const free = new Set(state.configDraft?.freeModelOrder || []);
  const models = catalogModels().filter((model) => {
    const capabilityTags = modelCapabilityTags(model).map((item) => String(item).toLowerCase());
    const searchable = `${model.displayName || ""} ${model.id || ""} ${model.upstreamId || ""} ${modelProvider(model)} ${capabilityTags.join(" ")}`.toLowerCase();
    const modalities = [...(model.inputModalities || []), ...(model.outputModalities || [])].map((item) => String(item).toLowerCase());
    if (text && !searchable.includes(text)) return false;
    if (provider !== "all" && modelProvider(model) !== provider) return false;
    if (protocol !== "all" && !modelSupports(model, protocol)) return false;
    if (modality !== "all" && !modalities.includes(modality) && !capabilityTags.includes(modality)) return false;
    if (enabledState === "enabled" && !isModelEnabled(model)) return false;
    if (enabledState === "disabled" && isModelEnabled(model)) return false;
    if (order === "openai" && !openai.has(model.id)) return false;
    if (order === "anthropic" && !anthropic.has(model.id)) return false;
    if (order === "paid-openrouter" && !paidOpenRouter.has(model.id)) return false;
    if (order === "free" && !free.has(model.id)) return false;
    if (order === "unordered" && (openai.has(model.id) || anthropic.has(model.id) || paidOpenRouter.has(model.id) || free.has(model.id))) return false;
    if (freeOnly && !isFreeExternalModel(model)) return false;
    if (minimumPrice !== null || maximumPrice !== null) {
      const price = modelPrice(model, priceBasis);
      if (price === null || price === undefined || !Number.isFinite(Number(price))) return false;
      if (minimumPrice !== null && Number(price) < minimumPrice) return false;
      if (maximumPrice !== null && Number(price) > maximumPrice) return false;
    }
    return true;
  });
  const sort = byId("model-sort")?.value || "name";
  const direction = byId("model-sort-direction")?.value === "desc" ? -1 : 1;
  const numeric = {
    context: (model) => model.contextTokens,
    inputPrice: (model) => modelPrice(model, "input"),
    outputPrice: (model) => modelPrice(model, "output"),
    quality: (model) => model.modelRatio
  }[sort];
  models.sort((a, b) => {
    if (!numeric) return String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)) * direction;
    const left = numeric(a); const right = numeric(b);
    const leftMissing = left === null || left === undefined || !Number.isFinite(Number(left));
    const rightMissing = right === null || right === undefined || !Number.isFinite(Number(right));
    if (leftMissing || rightMissing) return leftMissing === rightMissing ? String(a.id).localeCompare(String(b.id)) : leftMissing ? 1 : -1;
    return (Number(left) - Number(right)) * direction || String(a.id).localeCompare(String(b.id));
  });
  return models;
}

function modelHealthLabel(model) {
  const health = state.status?.metrics?.health || [];
  const matches = health.filter((item) => item.model === model.id);
  if (!matches.length) return "--";
  return [...new Set(matches.map((item) => healthState(item)[0]))].join(", ");
}

function renderModelDetail(model) {
  const detail = byId("model-detail");
  if (!detail) return;
  detail.replaceChildren();
  if (!model) {
    const empty = document.createElement("p");
    empty.textContent = "Select a model for details.";
    detail.append(empty);
    return;
  }
  const title = document.createElement("h4");
  title.textContent = `${model.displayName || model.id} / ${modelProvider(model)}`;
  const summary = document.createElement("p");
  const pricing = model.pricing || {};
  summary.textContent = `Route ${model.id} / upstream ${unknown(model.upstreamId)} / context ${unknown(model.contextTokens, compactNumber)} / max output ${unknown(model.maxOutputTokens, compactNumber)} / input ${priceText(modelPrice(model, "input"), pricing.currency)} / cache read ${priceText(modelPrice(model, "cacheRead"), pricing.currency)} / cache write ${priceText(modelPrice(model, "cacheWrite"), pricing.currency)} / output ${priceText(modelPrice(model, "output"), pricing.currency)} / quality ${unknown(model.modelRatio)} / completion ${unknown(model.completionRatio)} / capabilities ${modelCapabilityTags(model).join(", ") || "--"}`;
  detail.append(title, summary);
}

function renderModelRows() {
  const body = byId("model-browser");
  if (!body || !state.configDraft) return;
  body.replaceChildren();
  const matchingModels = filteredModels();
  const models = state.showAllModels ? matchingModels : matchingModels.slice(0, 200);
  const resultCount = byId("model-result-count");
  if (resultCount) resultCount.textContent = matchingModels.length > models.length
    ? `SHOWING ${models.length} OF ${matchingModels.length} MODELS`
    : `${matchingModels.length} MODEL${matchingModels.length === 1 ? "" : "S"}`;
  const showAll = byId("model-show-all");
  if (showAll) {
    showAll.hidden = matchingModels.length <= 200;
    showAll.textContent = state.showAllModels ? "SHOW FIRST 200" : `SHOW ALL ${matchingModels.length}`;
  }
  const openai = new Set(state.configDraft.openaiOrder);
  const anthropic = new Set(state.configDraft.anthropicOrder);
  const paidOpenRouter = new Set(state.configDraft.paidOpenRouterFallbackOrder);
  const free = new Set(state.configDraft.freeModelOrder);
  for (const model of models) {
    const row = document.createElement("tr");
    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedModels.has(model.id);
    checkbox.setAttribute("aria-label", `Select ${model.displayName || model.id}`);
    checkbox.dataset.selectModel = model.id;
    selectCell.append(checkbox);
    const identity = document.createElement("td");
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "model-detail-button";
    detailButton.dataset.modelDetail = model.id;
    detailButton.textContent = model.displayName || model.id;
    const route = document.createElement("small");
    route.textContent = `${modelProvider(model)} / ${model.id}`;
    identity.append(detailButton, route);
    const features = document.createElement("td");
    const limits = document.createElement("small");
    limits.textContent = `${unknown(model.contextTokens, compactNumber)} ctx / ${unknown(model.maxOutputTokens, compactNumber)} max out`;
    const tags = document.createElement("div");
    tags.className = "model-tags";
    for (const tag of [...(model.inputModalities || []), ...(model.outputModalities || []), ...modelCapabilityTags(model)].slice(0, 8)) {
      const item = document.createElement("span"); item.className = "model-tag"; item.textContent = tag; tags.append(item);
    }
    if (isExternalModel(model)) {
      const access = document.createElement("span");
      access.className = `model-tag ${isFreeExternalModel(model) ? "free" : "paid"}`;
      access.textContent = isFreeExternalModel(model) ? "FREE" : "PAID / OPT-IN";
      tags.prepend(access);
    }
    features.append(limits, tags);
    const prices = document.createElement("td");
    const pricing = model.pricing || {};
    prices.textContent = `${priceText(modelPrice(model, "input"), pricing.currency)} in / ${priceText(modelPrice(model, "output"), pricing.currency)} out`;
    const cache = document.createElement("small");
    cache.textContent = `${priceText(modelPrice(model, "cacheRead"), pricing.currency)} read / ${priceText(modelPrice(model, "cacheWrite"), pricing.currency)} write`;
    prices.append(cache);
    const wire = document.createElement("td");
    wire.textContent = (model.protocols || []).join(" / ") || "--";
    const health = document.createElement("small"); health.textContent = `Health: ${modelHealthLabel(model)}`; wire.append(health);
    const membership = document.createElement("td");
    membership.textContent = [openai.has(model.id) && `OAI #${state.configDraft.openaiOrder.indexOf(model.id) + 1}`, anthropic.has(model.id) && `ANT #${state.configDraft.anthropicOrder.indexOf(model.id) + 1}`, paidOpenRouter.has(model.id) && `OR PAID #${state.configDraft.paidOpenRouterFallbackOrder.indexOf(model.id) + 1}`, free.has(model.id) && `FREE #${state.configDraft.freeModelOrder.indexOf(model.id) + 1}`].filter(Boolean).join(" / ") || "--";
    const enabled = document.createElement("td");
    const label = document.createElement("label"); label.className = "model-toggle";
    const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = isModelEnabled(model); toggle.dataset.toggleModel = model.id;
    const toggleText = document.createElement("span"); toggleText.textContent = toggle.checked ? "YES" : "NO";
    label.append(toggle, toggleText); enabled.append(label);
    row.append(selectCell, identity, features, prices, wire, membership, enabled);
    body.append(row);
  }
  if (!models.length) {
    const row = document.createElement("tr"); row.className = "empty-row";
    const cell = document.createElement("td"); cell.colSpan = 7; cell.textContent = "NO MODELS MATCH FILTERS"; row.append(cell); body.append(row);
  }
  byId("model-selection-count").textContent = `${state.selectedModels.size} SELECTED`;
  const all = byId("model-select-all");
  if (all) { all.checked = Boolean(models.length) && models.every((model) => state.selectedModels.has(model.id)); all.indeterminate = models.some((model) => state.selectedModels.has(model.id)) && !all.checked; }
  renderModelDetail(catalogModels().find((model) => model.id === state.selectedModelId));
}

function orderConfigKey(protocol) {
  return { openai: "openaiOrder", anthropic: "anthropicOrder", "paid-openrouter": "paidOpenRouterFallbackOrder", free: "freeModelOrder" }[protocol];
}

function moveOrder(protocol, id, destination) {
  const key = orderConfigKey(protocol);
  const order = state.configDraft[key];
  const index = order.indexOf(id);
  if (index < 0) return;
  if (destination === "remove") order.splice(index, 1);
  else {
    const target = destination === "top" ? 0 : destination === "bottom" ? order.length - 1 : Math.max(0, Math.min(order.length - 1, index + destination));
    order.splice(index, 1);
    order.splice(target, 0, id);
  }
  setDraftDirty();
  renderModelManager();
  byId(`${protocol}-order-list`)?.querySelector(`[data-order-model="${CSS.escape(id)}"]`)?.focus();
}

function renderQualityOrders() {
  if (!state.configDraft) return;
  for (const protocol of ["openai", "anthropic", "paid-openrouter", "free"]) {
    const list = byId(`${protocol}-order-list`);
    const order = state.configDraft[orderConfigKey(protocol)];
    list.replaceChildren();
    order.forEach((id, index) => {
      const item = document.createElement("li"); item.className = "quality-order-item"; item.tabIndex = 0; item.dataset.orderModel = id; item.dataset.orderProtocol = protocol;
      const rank = document.createElement("span"); rank.textContent = `#${index + 1}`;
      const name = document.createElement("strong"); name.textContent = catalogModels().find((model) => model.id === id)?.displayName || id;
      const actions = document.createElement("div"); actions.className = "quality-order-actions";
      for (const [label, action, symbol] of [["Move to top", "top", "TOP"], ["Move up", "up", "UP"], ["Move down", "down", "DN"], ["Move to bottom", "bottom", "BOT"], ["Remove", "remove", "X"]]) {
        const button = document.createElement("button"); button.type = "button"; button.title = label; button.setAttribute("aria-label", `${label}: ${id}`); button.dataset.orderAction = action; button.textContent = symbol; actions.append(button);
      }
      item.append(rank, name, actions); list.append(item);
    });
  }
}

function renderCustomCascades() {
  const container = byId("custom-cascade-list");
  if (!container || !state.configDraft) return;
  container.replaceChildren();
  for (const cascade of state.configDraft.customCascades) {
    const card = document.createElement("article");
    card.className = "custom-cascade-card";
    const header = document.createElement("header");
    const title = document.createElement("strong"); title.textContent = cascade.name;
    const add = document.createElement("button"); add.type = "button"; add.className = "button secondary"; add.dataset.cascadeAddSelected = cascade.name; add.textContent = "ADD SELECTED";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "button secondary"; remove.dataset.cascadeDelete = cascade.name; remove.textContent = "DELETE QUEUE";
    header.append(title, add, remove);
    const members = document.createElement("textarea"); members.rows = Math.min(12, Math.max(4, cascade.members.length + 1)); members.value = cascade.members.join("\n"); members.dataset.cascadeMembers = cascade.name; members.setAttribute("aria-label", `${cascade.name} cascade members in order`);
    const help = document.createElement("small"); help.textContent = "One physical route ID per line. Top entry is attempted first.";
    card.append(header, members, help); container.append(card);
  }
}

function renderModelManager() {
  if (!state.configDraft || !byId("model-manager")) return;
  renderProviderCards();
  const providerSelect = byId("model-provider-filter");
  const current = providerSelect.value;
  providerSelect.replaceChildren(new Option("All providers", "all"));
  for (const provider of catalogProviders()) providerSelect.append(new Option(provider.name || provider.id, provider.id));
  providerSelect.value = [...providerSelect.options].some((option) => option.value === current) ? current : "all";
  renderModelRows();
  renderQualityOrders();
  renderCustomCascades();
}

function normalizeBaseline(value) {
  if (!value || typeof value !== "object") return null;
  const keys = ["success", "requests", "tokens", "cost", "cache", "uptime"];
  if (keys.some((key) => !Number.isFinite(Number(value[key])))) return null;
  return Object.fromEntries(keys.map((key) => [key, Number(value[key])]).concat([["markedAt", Number(value.markedAt) || Date.now()]]));
}

state.baseline = normalizeBaseline(readStoredJson(sessionStorage, BASELINE_KEY));

function currentTotals() {
  const totals = state.status?.metrics?.totals;
  if (!totals) return null;
  return {
    success: totals.requests ? totals.successes / totals.requests * 100 : 0,
    requests: totals.requests,
    tokens: totals.inputTokens + totals.outputTokens,
    cost: totals.estimatedCostUsd,
    cache: (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0),
    uptime: state.status.runtime.uptimeSeconds,
    markedAt: Date.now()
  };
}

function markBaseline() {
  const baseline = currentTotals();
  if (!baseline) return;
  state.baseline = baseline;
  sessionStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  renderBaseline();
  notify("Baseline marked for this tab.", true);
}

function clearBaseline({ notifyUser = true } = {}) {
  state.baseline = null;
  sessionStorage.removeItem(BASELINE_KEY);
  renderBaseline();
  if (notifyUser) notify("Baseline cleared.", true);
}

function renderBaseline() {
  const current = currentTotals();
  const baseline = state.baseline;
  const status = byId("baseline-status");
  const values = {
    success: ["delta-success", (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)} pts`],
    requests: ["delta-requests", (value) => `${value >= 0 ? "+" : ""}${compactNumber(value)}`],
    tokens: ["delta-tokens", (value) => `${value >= 0 ? "+" : ""}${compactNumber(value)}`],
    cost: ["delta-cost", (value) => `${value >= 0 ? "+" : "-"}${costUsd(Math.abs(value))}`],
    cache: ["delta-cache", (value) => `${value >= 0 ? "+" : ""}${compactNumber(value)}`]
  };
  if (!baseline || !current) {
    if (status) {
      status.textContent = "NO BASELINE";
      status.classList.remove("active");
    }
    for (const [id] of Object.values(values)) {
      const element = byId(id);
      if (element) {
        element.textContent = "--";
        element.classList.remove("positive", "negative", "neutral");
      }
    }
    return;
  }
  if (current.requests < baseline.requests || current.uptime < baseline.uptime) {
    clearBaseline({ notifyUser: false });
    if (status) status.textContent = "BASELINE INVALIDATED / ROUTER RESTARTED";
    notify("Baseline invalidated after router restart.");
    return;
  }
  if (status) {
    status.textContent = `SINCE ${new Date(baseline.markedAt).toLocaleTimeString()}`;
    status.classList.add("active");
  }
  for (const [key, [id, formatter]] of Object.entries(values)) {
    const element = byId(id);
    if (element) {
      const delta = current[key] - baseline[key];
      element.textContent = formatter(delta);
      element.classList.toggle("positive", delta > 0);
      element.classList.toggle("negative", delta < 0);
      element.classList.toggle("neutral", delta === 0);
    }
  }
}

function setConnectionState(next) {
  if (!document.body) return;
  const previous = state.connectionState;
  state.connectionState = next;
  document.body.dataset.connectionState = next;
  const labels = {
    online: "ROUTER ONLINE",
    stale: "TELEMETRY STALE",
    offline: "CONNECTION LOST",
    paused: "UPDATES PAUSED"
  };
  const connectionLabels = [byId("connection-label")].filter(Boolean);
  if (previous !== next || connectionLabels.some((label) => label.textContent !== labels[next])) {
    for (const label of connectionLabels) label.textContent = labels[next];
  }
  byId("live-dot")?.classList.toggle("connected", next === "online");
}

function updateStaleness() {
  if (document.visibilityState !== "visible") {
    setConnectionState("paused");
    return;
  }
  if (state.lastSuccessfulLoad && Date.now() - state.lastSuccessfulLoad > 12_000) setConnectionState("stale");
}

function render(payload) {
  state.status = payload;
  state.liveUpdatesAvailable = payload.runtime.liveUpdatesAvailable === true;
  const totals = payload.metrics.totals;
  const inFlight = payload.metrics.inFlight || [];
  const successRate = totals.requests ? totals.successes / totals.requests * 100 : null;
  if (successRate == null) {
    const successElement = byId("success-rate");
    const animation = state.metricAnimations.get(successElement);
    if (animation) cancelAnimationFrame(animation);
    state.metricAnimations.delete(successElement);
    successElement.textContent = "NO DATA";
    delete successElement.dataset.numericValue;
  } else {
    animateNumber(byId("success-rate"), successRate, (value) => `${value.toFixed(1)}%`);
  }
  byId("success-meter").style.width = `${successRate ?? 0}%`;
  animateNumber(byId("request-count"), totals.requests, (value) => compactNumber(Math.round(value)));
  const reportedTokens = totals.inputTokens + totals.outputTokens;
  animateNumber(byId("token-count"), reportedTokens, (value) => compactNumber(Math.round(value)));
  byId("token-split").textContent = [
    `${compactNumber(totals.inputTokens)} in`,
    `${compactNumber(totals.outputTokens)} out`
  ].join(" / ");
  animateNumber(byId("cost-count"), totals.estimatedCostUsd, costUsd);
  byId("reported-cost").textContent = `Reported billing: ${costCny(totals.costCny)}`;
  const cacheTokens = (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0);
  animateNumber(byId("cache-count"), cacheTokens, (value) => compactNumber(Math.round(value)));
  byId("cache-detail").textContent = `${compactNumber(totals.cacheReadTokens || 0)} read / ${compactNumber(totals.cacheWriteTokens || 0)} write`;

  const averageLatency = totals.requests ? totals.totalDurationMs / totals.requests : null;
  const averageTtft = totals.ttftSamples ? totals.totalTtftMs / totals.ttftSamples : null;
  const exactThroughput = totals.totalGenerationDurationMs
    ? totals.generationOutputTokens * 1_000 / totals.totalGenerationDurationMs
    : null;
  byId("average-latency").textContent = duration(averageLatency);
  byId("average-ttft").textContent = duration(averageTtft);
  byId("exact-throughput").textContent = exactThroughput == null ? "--" : `${exactThroughput.toFixed(1)} tok/s`;
  byId("attempts-per-request").textContent = totals.requests
    ? (totals.upstreamAttempts / totals.requests).toFixed(2)
    : "--";
  byId("fallback-rate").textContent = totals.requests
    ? `${(totals.fallbacks / totals.requests * 100).toFixed(1)}%`
    : "--";
  byId("failure-count").textContent = totals.requests
    ? `${compactNumber(totals.failures)} / ${(totals.failures / totals.requests * 100).toFixed(1)}%`
    : "0";
  byId("model-count").textContent = String(payload.catalog.models.length);
  byId("catalog-source").textContent = payload.catalog.lastError
    ? "catalog sync error"
    : `${payload.catalog.source} data`;

  byId("uptime").textContent = uptime(payload.runtime.uptimeSeconds);
  byId("node-version").textContent = payload.runtime.node;
  byId("upstream").textContent = `${(payload.providers || []).filter((provider) => provider.configured).length} / ${(payload.providers || []).length} configured`;
  byId("client-auth").textContent = payload.runtime.proxyAuthenticationEnabled ? "ENFORCED" : "LOOPBACK ONLY";
  byId("api-client-auth").textContent = payload.runtime.proxyAuthenticationEnabled ? "API KEY REQUIRED" : "NOT ENFORCED";
  byId("catalog-sync").textContent = payload.catalog.lastError
    ? `ERROR: ${payload.catalog.lastError}`
    : payload.catalog.lastRefresh
      ? new Date(payload.catalog.lastRefresh).toLocaleString()
      : "NOT YET SYNCED";

  renderHealth(payload.catalog, payload.metrics, payload.config);
  renderLiveTelemetry(inFlight, payload.metrics.recent || []);
  renderRecent(payload.metrics.recent || []);
  if (!state.configDirty) fillConfig(payload.config);
  else if (state.configOpen) renderModelManager();
  renderChatModelOptions(payload.config);
  renderBaseline();
  byId("updated-at").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function renderLiveTelemetry(inFlight, recent) {
  updateSandboxPendingMetrics(inFlight);
  const liveThroughput = inFlight.reduce((sum, request) => sum + (request.estimatedOutputTokensPerSecond || 0), 0);
  const activeStreams = inFlight.filter((request) => request.estimatedOutputTokensPerSecond != null).length;
  animateNumber(byId("live-throughput"), liveThroughput, (value) => value.toFixed(1), 420);
  byId("live-throughput-detail").textContent = activeStreams
    ? `EST. TOK/S / ${activeStreams} ACTIVE STREAM${activeStreams === 1 ? "" : "S"}`
    : `EST. TOK/S / ${inFlight.length ? "WAITING FOR OUTPUT" : "NO ACTIVE STREAMS"}`;
  byId("live-pulse").classList.toggle("active", inFlight.length > 0);
  byId("active-count").textContent = `${inFlight.length} ACTIVE`;
  const totals = state.status?.metrics?.totals;
  if (totals) {
    byId("request-detail").textContent = [
      `${compactNumber(inFlight.length)} active`,
      `${compactNumber(totals.upstreamAttempts || 0)} upstream attempts`,
      `${compactNumber(totals.fallbacks)} fallback`,
      `${compactNumber(totals.clientCancellations || 0)} cancelled`
    ].join(" / ");
  }
  renderLiveRequests(inFlight, recent);
}

function updateSandboxPendingMetrics(inFlight) {
  for (const pending of state.pendingSandboxCards.values()) {
    const model = pending.model;
    const request = [...inFlight].reverse().find((entry) => entry.requestedModel === model || entry.selectedModel === model);
    if (!request) continue;
    pending.elapsed.textContent = `${(request.durationMs / 1000).toFixed(1)} s`;
    pending.tokens.textContent = `${request.estimatedOutputTokens.toFixed(1)} est. tokens`;
    pending.rate.textContent = request.estimatedOutputTokensPerSecond == null ? "waiting for output" : `${request.estimatedOutputTokensPerSecond.toFixed(1)} tok/s est.`;
    pending.progress.setAttribute("aria-valuetext", `${pending.elapsed.textContent}, ${pending.tokens.textContent}, ${pending.rate.textContent}`);
  }
}

async function loadLive() {
  if (!state.liveUpdatesAvailable || state.liveLoadBusy || document.visibilityState !== "visible") return;
  state.liveLoadBusy = true;
  try {
    const payload = await api("/admin/api/live");
    renderLiveTelemetry(payload.inFlight || [], payload.recent || []);
    if (payload.completedRequests !== state.status?.metrics?.totals?.requests) await load(true);
  } catch (error) {
    if (error.status === 404) state.liveUpdatesAvailable = false;
  } finally {
    state.liveLoadBusy = false;
  }
}

function notify(message, successful = false) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.className = `notice${successful ? " success" : ""}`;
  window.clearTimeout(notice._timer);
  notice._timer = window.setTimeout(() => notice.classList.add("hidden"), 5000);
}

async function copyToClipboard(text, successMessage, fallbackMessage = "Clipboard access was unavailable. Select the text manually.") {
  try {
    await navigator.clipboard.writeText(text);
    notify(successMessage, true);
    return true;
  } catch {
    notify(fallbackMessage);
    return false;
  }
}

function setAudioStatus(message, failed = false) {
  const target = byId("audio-status");
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("failed", failed);
}

function audioModelId(model) {
  return typeof model === "string" ? model : String(model?.id || model?.model || model?.name || "");
}

function audioModels(payload, kind) {
  const section = kind === "tts" ? payload?.tts || payload?.speech : payload?.stt || payload?.transcriptions || payload?.transcription;
  const source = Array.isArray(section) ? section : section?.models || payload?.[`${kind}Models`] || [];
  const models = Array.isArray(source) ? source : Object.entries(source || {}).map(([id, value]) => typeof value === "object" ? { id, ...value } : id);
  return models.filter((model) => audioModelId(model) && (typeof model === "string" || (model.available !== false && model.enabled !== false)));
}

function audioVoices(payload, model) {
  const id = audioModelId(model);
  const section = payload?.tts || payload?.speech || {};
  const source = typeof model === "object" && Array.isArray(model.voices)
    ? model.voices
    : Array.isArray(section.voices) ? section.voices : section.voices?.[id] || payload?.voices?.[id] || [];
  return (Array.isArray(source) ? source : []).map((voice) => typeof voice === "string" ? voice : String(voice?.id || voice?.voice || voice?.name || "")).filter(Boolean);
}

function audioProvider(model) {
  if (typeof model === "object" && model.provider) return String(model.provider);
  const id = audioModelId(model);
  if (id.includes(":")) return id.split(":", 1)[0];
  if (/requesty/i.test(id)) return "Requesty";
  if (/fish/i.test(id)) return "Fish Audio";
  if (/deepgram|flux/i.test(id)) return "OpenRouter / Deepgram";
  return "configured speech provider";
}

function persistAudioSettings() {
  try { localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(audioState.settings)); } catch {}
}

function fillAudioSelect(select, models, selected, emptyLabel) {
  select.replaceChildren();
  for (const model of models) {
    const id = audioModelId(model);
    const display = typeof model === "object" ? String(model.label || model.displayName || id) : id;
    const option = new Option(`${display}${display !== id ? ` / ${id}` : ""}${model?.free ? " / FREE" : ""}`, id);
    select.append(option);
  }
  if (!models.length) select.append(new Option(emptyLabel, ""));
  select.disabled = !models.length;
  if (models.some((model) => audioModelId(model) === selected)) select.value = selected;
}

function syncAudioControls() {
  if (!audioState.capabilities) return;
  const ttsModels = audioModels(audioState.capabilities, "tts");
  const sttModels = audioModels(audioState.capabilities, "stt");
  const supportedTts = new Set(ttsModels.map(audioModelId));
  const supportedStt = new Set(sttModels.map(audioModelId));
  if (!supportedTts.has(audioState.settings.ttsModel)) {
    audioState.settings.ttsModel = supportedTts.has(DEFAULT_TTS_MODEL) ? DEFAULT_TTS_MODEL : audioModelId(ttsModels[0]);
  }
  if (!supportedStt.has(audioState.settings.sttModel)) {
    audioState.settings.sttModel = audioModelId(
      sttModels.find((model) => audioModelId(model).startsWith("local:"))
      || sttModels.find((model) => /requesty/i.test(`${audioProvider(model)} ${audioModelId(model)}`))
      || sttModels[0]
    );
  }
  fillAudioSelect(byId("audio-stt-model"), sttModels, audioState.settings.sttModel, "No STT model available");
  fillAudioSelect(byId("audio-tts-model"), ttsModels, audioState.settings.ttsModel, "No TTS model available");
  const selectedTts = ttsModels.find((model) => audioModelId(model) === audioState.settings.ttsModel);
  const voices = selectedTts ? audioVoices(audioState.capabilities, selectedTts) : [];
  if (!voices.includes(audioState.settings.voice)) audioState.settings.voice = voices.includes(DEFAULT_TTS_VOICE) ? DEFAULT_TTS_VOICE : voices[0] || "";
  fillAudioSelect(byId("audio-voice"), voices, audioState.settings.voice, voices.length ? "Provider default" : "No voice advertised");
  byId("audio-language").value = audioState.settings.language;
  byId("audio-speed").value = String(audioState.settings.speed);
  const canRecord = Boolean(sttModels.length && window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  byId("audio-record").disabled = !canRecord;
  byId("audio-record").title = canRecord ? "Record up to 3 minutes / 16 MiB" : !sttModels.length ? "No STT model is configured" : !window.isSecureContext ? "Microphone recording requires HTTPS or localhost" : "This browser does not support audio recording";
  byId("audio-file").disabled = !sttModels.length;
  byId("audio-file-button").disabled = !sttModels.length;
  byId("audio-file-button").title = sttModels.length ? "Choose an audio file up to 16 MiB" : "No STT model is configured";
  for (const button of document.querySelectorAll(".tts-listen")) {
    button.disabled = !ttsModels.length;
    button.title = ttsModels.length ? "Read this result aloud" : "No TTS model is configured";
  }
  const providers = [...new Set([sttModels.find((model) => audioModelId(model) === audioState.settings.sttModel), selectedTts].filter(Boolean).map(audioProvider))];
  byId("audio-privacy").textContent = `Explicit speech actions send audio or result text to ${providers.join(" and ") || "no configured provider"}. Clips, playback, and object URLs are ephemeral and are never saved.`;
  const availability = !sttModels.length && !ttsModels.length
    ? "SPEECH UNAVAILABLE / NO MODELS CONFIGURED"
    : !sttModels.length ? "TTS READY / STT UNAVAILABLE"
      : !ttsModels.length ? "STT READY / TTS UNAVAILABLE"
      : !window.isSecureContext ? "READY FOR FILE / MICROPHONE REQUIRES HTTPS OR LOCALHOST"
        : !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder ? "READY FOR FILE / RECORDING UNSUPPORTED"
          : "READY / AUDIO IS EPHEMERAL";
  setAudioStatus(availability, !sttModels.length && !ttsModels.length);
  persistAudioSettings();
}

async function loadAudioCapabilities() {
  if (audioState.capabilities) { syncAudioControls(); return audioState.capabilities; }
  if (audioState.capabilitiesPromise) return audioState.capabilitiesPromise;
  setAudioStatus("LOADING SPEECH CAPABILITIES");
  audioState.capabilitiesPromise = audioFetch("/admin/api/audio/capabilities")
    .then((response) => response.json())
    .then((payload) => { audioState.capabilities = payload; syncAudioControls(); return payload; })
    .catch((error) => {
      setAudioStatus(`SPEECH UNAVAILABLE / ${error.message}`, true);
      byId("audio-record").disabled = true;
      byId("audio-file").disabled = true;
      byId("audio-file-button").disabled = true;
      throw error;
    })
    .finally(() => { audioState.capabilitiesPromise = null; });
  return audioState.capabilitiesPromise;
}

function captureTranscriptTarget() {
  const input = byId("chat-input");
  const workspace = activeWorkspace();
  return { mode: workspace.mode, runId: workspace.runId, draft: input.value, start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length };
}

function stopMediaTracks() {
  for (const track of audioState.stream?.getTracks?.() || []) track.stop();
  audioState.stream = null;
}

function stopRecorder(transcribe = false, reason = "RECORDING STOPPED") {
  audioState.recordingRequest += 1;
  if (!audioState.recorder) return;
  audioState.recorder._transcribe = transcribe;
  audioState.recorder._stopReason = reason;
  if (audioState.recorder.state !== "inactive") audioState.recorder.stop();
  else stopMediaTracks();
}

async function transcribeAudio(file, target) {
  audioState.sttController?.abort();
  stopTts();
  if (!file || file.size > AUDIO_MAX_BYTES) return setAudioStatus("AUDIO REJECTED / 16 MiB MAXIMUM", true);
  const language = audioState.settings.language.trim();
  if (language && !/^[a-z]{2}$/.test(language)) return setAudioStatus("TRANSCRIPTION REFUSED / LANGUAGE MUST BE TWO LOWERCASE LETTERS", true);
  if (byId("transcript-review-dialog").open) byId("transcript-review-dialog").close("replaced");
  audioState.sttController = new AbortController();
  const controller = audioState.sttController;
  const form = new FormData();
  const extension = file.type.includes("ogg") ? "ogg" : file.type.includes("mp4") ? "mp4" : file.type.includes("mpeg") ? "mp3" : file.type.includes("wav") ? "wav" : "webm";
  form.append("file", file, file.name || `recording-${Date.now()}.${extension}`);
  form.append("model", audioState.settings.sttModel);
  if (language) form.append("language", language);
  setAudioStatus("TRANSCRIBING / AUDIO HELD IN MEMORY");
  try {
    const response = await audioFetch("/admin/api/audio/transcriptions", { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json();
    if (!payload || typeof payload.text !== "string") throw new Error("Transcription returned no text");
    audioState.transcriptTarget = target;
    byId("transcript-review-text").value = payload.text.slice(0, 50000);
    byId("transcript-review-dialog").showModal();
    byId("transcript-review-text").focus();
    setAudioStatus("TRANSCRIPT READY / REVIEW REQUIRED");
  } catch (error) {
    if (error.name !== "AbortError") setAudioStatus(`TRANSCRIPTION FAILED / ${error.message}`, true);
  } finally {
    if (audioState.sttController === controller) audioState.sttController = null;
    file = null;
  }
}

async function startRecording() {
  if (audioState.recorder?.state === "recording") return stopRecorder(true, "TRANSCRIBING RECORDING");
  audioState.sttController?.abort();
  const target = captureTranscriptTarget();
  const request = ++audioState.recordingRequest;
  byId("audio-record").disabled = true;
  setAudioStatus("WAITING FOR MICROPHONE PERMISSION");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (request !== audioState.recordingRequest || document.visibilityState === "hidden" || !state.chatOpen) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    audioState.stream = stream;
    const types = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
    const mimeType = types.find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    audioState.recorder = recorder;
    audioState.chunks = [];
    audioState.bytes = 0;
    recorder.ondataavailable = (event) => {
      if (!event.data?.size) return;
      audioState.bytes += event.data.size;
      if (audioState.bytes > AUDIO_MAX_BYTES) return stopRecorder(false, "RECORDING DISCARDED / 16 MiB LIMIT");
      audioState.chunks.push(event.data);
    };
    recorder.onerror = () => stopRecorder(false, "RECORDING FAILED");
    recorder.onstop = () => {
      window.clearTimeout(audioState.timer);
      const chunks = audioState.chunks;
      const shouldTranscribe = recorder._transcribe && audioState.bytes <= AUDIO_MAX_BYTES;
      audioState.chunks = [];
      audioState.bytes = 0;
      audioState.recorder = null;
      stopMediaTracks();
      byId("audio-record").textContent = "RECORD";
      byId("audio-record").setAttribute("aria-pressed", "false");
      if (shouldTranscribe) void transcribeAudio(new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" }), target);
      else setAudioStatus(recorder._stopReason || "RECORDING DISCARDED", true);
    };
    recorder.start(1000);
    byId("audio-record").disabled = false;
    byId("audio-record").textContent = "STOP";
    byId("audio-record").setAttribute("aria-pressed", "true");
    setAudioStatus("RECORDING / STOP TO TRANSCRIBE");
    audioState.timer = window.setTimeout(() => stopRecorder(true, "TRANSCRIBING / 3 MINUTE LIMIT"), AUDIO_MAX_MS);
  } catch (error) {
    stopMediaTracks();
    audioState.recorder = null;
    if (request === audioState.recordingRequest) setAudioStatus(`MICROPHONE UNAVAILABLE / ${error.message}`, true);
  } finally {
    if (!audioState.recorder) byId("audio-record").disabled = !(audioModels(audioState.capabilities, "stt").length && window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }
}

function markdownPlainText(text) {
  const shell = document.createElement("div");
  shell.innerHTML = renderMarkdown(String(text || ""));
  return shell.innerText.replace(/\n{3,}/g, "\n\n").trim();
}

function resultSpeechText(result, mode) {
  if (mode !== "design") return markdownPlainText(result.content).slice(0, 4096);
  const parsed = new DOMParser().parseFromString(extractDesignHtml(result.content), "text/html");
  parsed.querySelectorAll("script, style, noscript, template").forEach((element) => element.remove());
  return (parsed.body?.innerText || parsed.body?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4096);
}

function setTtsButton(button, label, pressed = false) {
  if (!button?.isConnected) return;
  button.textContent = label;
  button.setAttribute("aria-pressed", String(pressed));
}

function stopTts(label = "LISTEN") {
  audioState.ttsController?.abort();
  audioState.ttsController = null;
  if (audioState.playback) {
    audioState.playback.onended = null;
    audioState.playback.onerror = null;
    audioState.playback.pause();
    audioState.playback.removeAttribute("src");
    audioState.playback.load();
  }
  if (audioState.playbackUrl) URL.revokeObjectURL(audioState.playbackUrl);
  setTtsButton(audioState.ttsButton, label);
  audioState.playback = null;
  audioState.playbackUrl = null;
  audioState.ttsButton = null;
  audioState.ttsKey = null;
  audioState.ttsStatus = label;
}

async function playResultSpeech(button, result, mode, key) {
  if (audioState.ttsKey === key) {
    if (audioState.ttsController || (audioState.playback && !audioState.playback.paused)) return stopTts();
    if (audioState.playback) {
      const playback = audioState.playback;
      try {
        await playback.play();
        if (audioState.playback !== playback) return;
        setTtsButton(button, "STOP", true); audioState.ttsStatus = "STOP";
      } catch {
        if (audioState.playback !== playback) return;
        setTtsButton(button, "PLAY READY"); audioState.ttsStatus = "PLAY READY";
      }
      return;
    }
  }
  stopTts();
  let input;
  try { input = resultSpeechText(result, mode); }
  catch (error) { setTtsButton(button, "FAILED"); return setAudioStatus(`SPEECH FAILED / ${error.message}`, true); }
  if (!input) { setTtsButton(button, "FAILED"); return setAudioStatus("SPEECH FAILED / RESULT HAS NO READABLE TEXT", true); }
  const controller = new AbortController();
  audioState.ttsController = controller;
  audioState.ttsButton = button;
  audioState.ttsKey = key;
  audioState.ttsStatus = "LOADING";
  setTtsButton(button, "LOADING", true);
  setAudioStatus(`SYNTHESIZING / ${audioProvider(audioState.settings.ttsModel)}`);
  try {
    const response = await audioFetch("/admin/api/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: audioState.settings.ttsModel, input, ...(audioState.settings.voice ? { voice: audioState.settings.voice } : {}), responseFormat: "mp3", speed: audioState.settings.speed }),
      signal: controller.signal
    });
    const blob = await response.blob();
    if (audioState.ttsController !== controller) return;
    if (!blob.size) throw new Error("Speech provider returned empty audio");
    const url = URL.createObjectURL(blob);
    const playback = new Audio(url);
    audioState.ttsController = null;
    audioState.playbackUrl = url;
    audioState.playback = playback;
    playback.onended = () => stopTts();
    playback.onerror = () => { const current = audioState.ttsButton; stopTts(); setTtsButton(current, "FAILED"); setAudioStatus("PLAYBACK FAILED", true); };
    try {
      await playback.play();
      if (audioState.playback !== playback) return;
      setTtsButton(button, "STOP", true); audioState.ttsStatus = "STOP"; setAudioStatus("PLAYING / CLICK STOP TO END");
    } catch {
      if (audioState.playback !== playback) return;
      setTtsButton(button, "PLAY READY"); audioState.ttsStatus = "PLAY READY"; setAudioStatus("AUDIO READY / CLICK PLAY READY");
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    stopTts("FAILED");
    setTtsButton(button, "FAILED");
    setAudioStatus(`SPEECH FAILED / ${error.message}`, true);
  }
}

function chatBubble(role, content = "") {
  byId("chat-messages").querySelector(".chat-empty")?.remove();
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;
  const header = document.createElement("header");
  header.textContent = role === "user" ? "YOU" : "ASSISTANT";
  const text = document.createElement("div");
  text.className = "content";
  if (role === "user") {
    text.textContent = content;
  } else {
    text.innerHTML = renderMarkdown(content);
  }
  article.append(header, text);

  byId("chat-messages").append(article);

  const container = byId("chat-messages");
  if (!state.userScrolled || role === "user") {
    article.scrollIntoView({ block: "end", behavior: role === "user" ? "smooth" : "auto" });
  }
  return { article, text };
}

function parseSseBlocks(buffer) {
  const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const parts = normalized.split("\n\n");
  return { blocks: parts.slice(0, -1), remainder: parts.at(-1) || "" };
}

function sandboxMessages(lane, prompt, workspace = activeWorkspace()) {
  const messages = [];
  for (const turn of workspace.turns) {
    messages.push({ role: "user", content: turn.prompt });
    const result = turn.results[lane.id] || turn.results[lane.model];
    if (result?.content && !result.error) messages.push({ role: "assistant", content: result.content });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function extractDesignHtml(value) {
  let html = String(value || "").trim();
  const fence = html.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (fence) html = fence[1].trim();
  const doctype = html.search(/<!doctype\s+html/i);
  const root = html.search(/<html[\s>]/i);
  const start = doctype >= 0 ? doctype : root;
  if (start > 0) html = html.slice(start);
  if (!html) throw new Error("No HTML artifact was returned");
  return html;
}

function designPreviewDocument(source, scripts = false) {
  const documentValue = new DOMParser().parseFromString(source, "text/html");
  documentValue.querySelectorAll('meta[http-equiv="Content-Security-Policy" i], meta[http-equiv="refresh" i], base').forEach((element) => element.remove());
  documentValue.querySelectorAll("a[href], area[href], form[action]").forEach((element) => {
    element.removeAttribute("href");
    element.removeAttribute("action");
  });
  for (const element of documentValue.querySelectorAll("[src], [poster]")) {
    for (const attribute of ["src", "poster"]) {
      const value = element.getAttribute(attribute);
      if (value && !/^(data:|blob:|#)/i.test(value.trim())) element.removeAttribute(attribute);
    }
  }
  const csp = documentValue.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = `default-src 'none'; script-src ${scripts ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; manifest-src 'none'`;
  const referrer = documentValue.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  const viewport = documentValue.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  documentValue.head.prepend(csp, referrer, viewport);
  return `<!doctype html>\n${documentValue.documentElement.outerHTML}`;
}

function designPopoutDocument(source, scripts, model) {
  const escaped = designPreviewDocument(source, scripts).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const title = String(model).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src 'self' data: blob:; base-uri 'none'"><title>${title} design preview</title><style>html,body{height:100%;margin:0;background:#090b0d;color:#e8edf1;font:12px monospace}header{height:38px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #293139}iframe{display:block;width:100%;height:calc(100% - 39px);border:0;background:white}</style></head><body><header>ROUTETOK DESIGN PREVIEW / ${title} / JAVASCRIPT ${scripts ? "ENABLED" : "DISABLED"}</header><iframe sandbox="${scripts ? "allow-scripts" : ""}" referrerpolicy="no-referrer" srcdoc="${escaped}"></iframe></body></html>`;
}

function designArtifact(result) {
  const source = extractDesignHtml(result.content);
  const shell = document.createElement("div");
  shell.className = "design-artifact";
  const toolbar = document.createElement("div");
  toolbar.className = "design-toolbar";
  const stage = document.createElement("div");
  stage.className = "design-stage";
  const sourceView = document.createElement("pre");
  sourceView.className = "design-source hidden";
  sourceView.textContent = source;
  let iframe;
  let scripts = false;
  const renderFrame = () => {
    iframe?.remove();
    iframe = document.createElement("iframe");
    iframe.title = `Design preview generated by ${result.requestedModel}`;
    iframe.setAttribute("sandbox", scripts ? "allow-scripts" : "");
    iframe.referrerPolicy = "no-referrer";
    iframe.style.width = "100%";
    iframe.srcdoc = designPreviewDocument(source, scripts);
    stage.prepend(iframe);
  };
  const actions = [
    ["PREVIEW", "preview"], ["SOURCE", "source"], ["MOBILE", "390"], ["TABLET", "768"], ["DESKTOP", "1440"], ["FIT", "fit"],
    ["ENABLE JS", "scripts"], ["POPOUT", "popout"], ["COPY", "copy"], ["EXPAND", "expand"], ["DOWNLOAD SAFE", "download"]
  ];
  for (const [label, action] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.textContent = label;
    button.addEventListener("click", async () => {
      if (action === "preview" || action === "source") {
        iframe.hidden = action === "source";
        sourceView.classList.toggle("hidden", action !== "source");
      } else if (["390", "768", "1440", "fit"].includes(action)) {
        iframe.dataset.viewport = action;
        iframe.style.width = action === "fit" ? "100%" : `${action}px`;
      } else if (action === "scripts") {
        if (!scripts && !confirm("Enable generated JavaScript inside an opaque sandbox? Network APIs and dashboard access remain blocked, but generated code can consume browser CPU or memory.")) return;
        scripts = !scripts; button.textContent = scripts ? "DISABLE JS" : "ENABLE JS"; renderFrame();
      } else if (action === "popout") {
        const popup = window.open("", "_blank");
        if (!popup) return notify("The browser blocked the design popout.");
        popup.opener = null; popup.document.open(); popup.document.write(designPopoutDocument(source, scripts, result.requestedModel)); popup.document.close();
      } else if (action === "copy") {
        await copyToClipboard(source, "Design source copied.", "Clipboard access was unavailable. Select the design source manually.");
      } else if (action === "expand") {
        shell.closest(".sandbox-result")?.classList.toggle("focused-result");
        button.textContent = shell.closest(".sandbox-result")?.classList.contains("focused-result") ? "COLLAPSE" : "EXPAND";
      } else if (action === "download") {
        const url = URL.createObjectURL(new Blob([designPreviewDocument(source, false)], { type: "text/html;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `design-${result.requestedModel.replace(/[^a-z0-9_-]+/gi, "-")}-${Date.now()}.html`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    });
    toolbar.append(button);
  }
  stage.append(sourceView);
  shell.append(toolbar, stage);
  renderFrame();
  return shell;
}

function sandboxResultCard(result, mode, context = {}) {
  const card = document.createElement("article");
  card.className = `sandbox-result${result.error ? " failed" : ""}`;
  card.dataset.sandboxModel = result.requestedModel;
  card.dataset.sandboxLane = result.laneId || result.requestedModel;
  if (Number.isInteger(context.turnIndex)) card.dataset.sandboxTurn = String(context.turnIndex);
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = result.laneLabel || result.requestedModel;
  const status = document.createElement("span");
  status.className = "status-pill";
  status.textContent = result.error ? "FAILED" : "COMPLETE";
  header.append(title, status);
  const quickActions = document.createElement("span");
  quickActions.className = "result-quick-actions";
  const quickActionList = [["COPY", "copy-result"], ["FOCUS", "focus-result"]];
  if (!result.error && Number.isInteger(context.turnIndex)) quickActionList.unshift(["LISTEN", "listen"]);
  for (const [label, action] of quickActionList) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `result-action${action === "listen" ? " tts-listen" : ""}`;
    button.dataset.resultAction = action;
    button.textContent = label;
    if (action === "focus-result" || action === "listen") button.setAttribute("aria-pressed", "false");
    if (action === "listen") {
      const key = `${activeWorkspace().runId}:${context.turnIndex}:${result.laneId || result.requestedModel}`;
      button.dataset.ttsKey = key;
      button.disabled = !audioModels(audioState.capabilities, "tts").length;
      button.title = audioModels(audioState.capabilities, "tts").length ? "Read this result aloud" : audioState.capabilities ? "No free TTS model is configured" : "Speech capabilities are loading";
      if (audioState.ttsKey === key) {
        audioState.ttsButton = button;
        setTtsButton(button, audioState.ttsStatus || "STOP", audioState.ttsStatus === "STOP" || audioState.ttsStatus === "LOADING");
      }
    }
    quickActions.append(button);
  }
  header.append(quickActions);
  if (Number.isInteger(context.turnIndex)) {
    const star = document.createElement("button"); star.type = "button"; star.className = `sandbox-star${result.starred ? " active" : ""}`; star.dataset.starLane = result.laneId || result.requestedModel; star.dataset.starTurn = String(context.turnIndex); star.setAttribute("aria-pressed", String(Boolean(result.starred))); star.title = result.starred ? "Remove from starred gallery" : "Add to starred gallery"; star.textContent = result.starred ? "★" : "☆"; header.append(star);
  }
  const content = document.createElement("div");
  content.className = "content";
  if (result.error) {
    const error = document.createElement("p"); error.className = "sandbox-error"; error.textContent = `Generation failed: ${result.error}`; card.append(header, error);
  }
  if (mode === "design" && result.content && !result.error) {
    try { content.append(designArtifact(result)); }
    catch (error) { content.textContent = `Could not preview design: ${error.message}`; }
  } else {
    content.innerHTML = renderMarkdown(result.content || (result.error ? `Error: ${result.error}` : "(No visible text returned)"));
  }
  if (result.error && result.content) {
    const warning = document.createElement("small"); warning.className = "sandbox-partial-warning"; warning.textContent = "PARTIAL OUTPUT / NOT USED AS FUTURE CONTEXT"; content.prepend(warning);
  }
  if (!header.isConnected) card.append(header);
  card.append(content);
  if (result.reasoning) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "THINKING";
    const thinking = document.createElement("pre");
    thinking.className = "thinking";
    thinking.textContent = result.reasoning;
    details.append(summary, thinking);
    card.append(details);
  }
  const metrics = result.metrics;
  const metricsDetails = document.createElement("details");
  metricsDetails.className = "sandbox-metrics-details";
  const metricsSummary = document.createElement("summary");
  const outputTokens = metrics?.tokens?.output;
  metricsSummary.textContent = metrics
    ? `DETAILS / ${metrics.provider || "provider unknown"} / ${metrics.status ?? "status unknown"} / ${duration(metrics.latencyMs)}${Number.isFinite(outputTokens) ? ` / ${compactNumber(outputTokens)} out` : ""}`
    : "DETAILS / METRICS UNAVAILABLE";
  const footer = document.createElement("footer");
  footer.className = "sandbox-metrics";
  const values = metrics ? [
    ["MODEL", result.requestedModel || "--"],
    ["ENDPOINT", metrics.endpoint || "/v1/chat/completions"],
    ["PROVIDER", metrics.provider || "--"],
    ["ROUTE", metrics.route || result.requestedModel || "--"],
    ["STATUS", metrics.status == null ? "--" : String(metrics.status)],
    ["REQUEST ID", metrics.requestId || "--"],
    ["ATTEMPTS", Array.isArray(metrics.attempts) ? `${metrics.attempts.length}${metrics.attempts.length ? ` / ${metrics.attempts.map((attempt) => `${attempt.model}:${attempt.status ?? attempt.outcome}`).join(" > ")}` : ""}` : "--"],
    ["LATENCY", duration(metrics.latencyMs)],
    ["TTFT", duration(metrics.ttftMs)],
    ["GENERATION", duration(metrics.generationDurationMs)],
    ["TOKENS", metrics.tokens ? `${compactNumber(metrics.tokens.input)} in / ${compactNumber(metrics.tokens.output)} out` : "--"],
    ["CACHE", metrics.tokens ? `${compactNumber(metrics.tokens.cacheRead || 0)} read / ${compactNumber(metrics.tokens.cacheWrite || 0)} write` : "--"],
    ["SPEED", metrics.outputTokensPerSecond == null ? "--" : `${metrics.outputTokensPerSecond.toFixed(1)} tok/s`],
    ["COST", metrics.costUsd == null ? "--" : costUsd(metrics.costUsd)],
    ["PARAMS", `${result.parameters?.maxTokens == null ? "provider default" : `${result.parameters.maxTokens} max`} / T ${result.parameters?.temperature ?? "default"} / P ${result.parameters?.topP ?? "default"}`]
  ] : [["METRICS", "Unavailable"]];
  for (const [label, value] of values) {
    const item = document.createElement("span");
    const key = document.createElement("small");
    const text = document.createElement("strong");
    key.textContent = label;
    text.textContent = value;
    item.append(key, text);
    footer.append(item);
  }
  metricsDetails.append(metricsSummary, footer);
  card.append(metricsDetails);
  if (result.error && mode === "diagnose" && Number.isInteger(context.turnIndex)) {
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "button secondary sandbox-retry"; retry.dataset.retryLane = result.laneId || result.requestedModel; retry.dataset.retryTurn = String(context.turnIndex); retry.textContent = "RETRY FAILED GENERATION"; card.append(retry);
  }
  return card;
}

function renderSandboxTurn(prompt, results, mode, turnIndex = null) {
  const bubble = chatBubble("user", prompt);
  const actions = document.createElement("div");
  actions.className = "prompt-actions";
  for (const [label, action] of [["COPY", "copy-prompt"], ["REUSE", "reuse-prompt"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.promptAction = action;
    button.textContent = label;
    actions.append(button);
  }
  bubble.article.append(actions);
  const grid = document.createElement("section");
  grid.className = "sandbox-results";
  grid.setAttribute("aria-label", "Model comparison results");
  for (const result of results) grid.append(sandboxResultCard(result, mode, { turnIndex }));
  byId("chat-messages").append(grid);
  if (!state.userScrolled) grid.scrollIntoView({ block: "end" });
}

function renderInflightWorkspace(workspace) {
  const inflight = workspace.inflight;
  const turn = beginParallelSandboxTurn(inflight.prompt, inflight.lanes, workspace);
  for (const lane of inflight.lanes) {
    const result = inflight.results[lane.id];
    if (!result) continue;
    const card = turn.cards.get(lane.id);
    if (card?._progressTimer) clearInterval(card._progressTimer);
    card?.replaceWith(sandboxResultCard(result, workspace.mode));
    workspace.pendingCards.delete(lane.id);
  }
}

function beginParallelSandboxTurn(prompt, lanes, workspace = activeWorkspace()) {
  chatBubble("user", prompt);
  const grid = document.createElement("section");
  grid.className = "sandbox-results";
  grid.setAttribute("aria-label", "Parallel model comparison results");
  const cards = new Map();
  for (const lane of lanes) {
    const model = lane.model;
    const card = document.createElement("article");
    card.className = "sandbox-result pending";
    const header = document.createElement("header");
    const title = document.createElement("strong");
    const duplicateCount = lanes.filter((candidate) => candidate.model === model).length;
    const sample = lanes.slice(0, lane.index + 1).filter((candidate) => candidate.model === model).length;
    title.textContent = `${model}${duplicateCount > 1 ? ` / SAMPLE ${sample}` : ""}`;
    const status = document.createElement("span");
    status.className = "status-pill";
    status.textContent = "GENERATING";
    const content = document.createElement("div");
    content.className = "content sandbox-pending";
    content.textContent = "Waiting for first output...";
    const progress = document.createElement("div");
    progress.className = "sandbox-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `${model} request in flight`);
    progress.setAttribute("aria-valuetext", "Generating response");
    const track = document.createElement("i");
    const metricsLine = document.createElement("span");
    metricsLine.className = "sandbox-progress-metrics";
    const elapsed = document.createElement("b");
    const tokens = document.createElement("b");
    const rate = document.createElement("b");
    const started = performance.now();
    elapsed.textContent = "0.0 s";
    tokens.textContent = "0.0 est. tokens";
    rate.textContent = "waiting for output";
    card._progressTimer = window.setInterval(() => {
      elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
    }, 100);
    metricsLine.append(elapsed, tokens, rate);
    progress.append(track, metricsLine);
    header.append(title, status);
    card.append(header, content, progress);
    grid.append(card);
    cards.set(lane.id, card);
    workspace.pendingCards.set(lane.id, { card, progress, elapsed, tokens, rate, model });
  }
  byId("chat-messages").append(grid);
  if (!state.userScrolled) grid.scrollIntoView({ block: "end" });
  return { grid, cards };
}

async function sendChat(message, workspace = activeWorkspace()) {
  if (workspace.busy) return;
  const lanes = workspaceModelLanes(workspace);
  if (!lanes.length) return notify("Select at least one sandbox model.");
  const submittedDraft = workspace.draft;
  if (!workspace.modelLineup.length) workspace.modelLineup = lanes.map((lane) => lane.model);
  if (workspace === activeWorkspace()) readGenerationControls(workspace);
  const temperatureText = String(workspace.parameters.temperature ?? "").trim();
  const topPText = String(workspace.parameters.topP ?? "").trim();
  const parameters = {
    ...(workspace.parameters.providerDefaultMax ? {} : { maxTokens: Number(workspace.parameters.maxTokens) }),
    ...(temperatureText ? { temperature: Number(temperatureText) } : {}),
    ...(topPText ? { topP: Number(topPText) } : {})
  };
  workspace.busy = true;
  workspace.status = "running";
  workspace.controller = new AbortController();
  workspace.inflight = { prompt: message, lanes, results: {}, parameters };
  if (workspace === activeWorkspace()) renderActiveWorkspace();
  persistArenaWorkspaces();

  try {
    let completed = 0;
    const results = await Promise.all(lanes.map(async (lane, index) => {
      const model = lane.model;
      let result;
      try {
        const response = await fetch("/admin/api/sandbox", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({ purpose: workspace.mode, requests: [{
            id: `model_${index}`,
            model,
            messages: sandboxMessages(lane, message, workspace),
            parameters
          }] }),
          signal: workspace.controller.signal
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(error.error?.message || error.error || `HTTP ${response.status}`);
        }
        const payload = await response.json();
        result = payload.results?.[0] || { requestedModel: model, content: "", reasoning: "", error: "Model returned no result", metrics: null, parameters };
      } catch (error) {
        result = { requestedModel: model, content: "", reasoning: "", error: error.name === "AbortError" ? "Cancelled" : error.message, metrics: null, parameters };
      }
      result.laneId = lane.id;
      const sameModelLanes = lanes.filter((candidate) => candidate.model === model);
      if (sameModelLanes.length > 1) {
        const sample = lanes.slice(0, index + 1).filter((candidate) => candidate.model === model).length;
        result.laneLabel = `${model} / SAMPLE ${sample}`;
      }
      workspace.inflight.results[lane.id] = result;
      const pending = workspace.pendingCards.get(lane.id);
      if (pending?.card?._progressTimer) clearInterval(pending.card._progressTimer);
      workspace.pendingCards.delete(lane.id);
      completed += 1;
      if (workspace === activeWorkspace()) {
        renderActiveWorkspace();
        byId("chat-route").textContent = `${completed} / ${lanes.length} COMPLETE`;
      }
      return result;
    }));
    workspace.turns.push({ prompt: message, mode: workspace.mode, parameters, results: Object.fromEntries(results.map((result) => [result.laneId, result])) });
    workspace.inflight = null;
    const successCount = results.filter((result) => !result.error).length;
    workspace.status = results.some((result) => result.error) ? "failed" : "ready";
    if (successCount && workspace.draft === submittedDraft) workspace.draft = "";
    await saveSandboxRun(workspace).catch((error) => notify(`Result could not be saved: ${error.message}`));
    if (workspace === activeWorkspace()) {
      renderActiveWorkspace();
      byId("chat-route").textContent = `${successCount} COMPLETE / ${results.length - successCount} FAILED`;
    }
  } catch (error) {
    workspace.status = "failed";
    workspace.inflight = null;
    if (workspace === activeWorkspace()) byId("chat-route").textContent = error.name === "AbortError" ? "STOPPED" : "REQUEST FAILED";
    if (error.name !== "AbortError") notify(error.message);
  } finally {
    workspace.busy = false;
    workspace.controller = null;
    persistArenaWorkspaces();
    if (workspace === activeWorkspace()) renderActiveWorkspace();
  }
}

function sandboxMessagesForTurn(laneId, model, turnIndex, workspace = activeWorkspace()) {
  const messages = [];
  for (let index = 0; index <= turnIndex; index++) {
    const turn = workspace.turns[index];
    messages.push({ role: "user", content: turn.prompt });
    if (index < turnIndex) {
      const result = turn.results[laneId] || turn.results[model];
      if (result?.content && !result.error) messages.push({ role: "assistant", content: result.content });
    }
  }
  return messages;
}

async function retrySandboxGeneration(laneId, turnIndex) {
  const workspace = activeWorkspace();
  if (workspace.busy) return;
  const turn = workspace.turns[turnIndex];
  const previous = turn?.results?.[laneId];
  const model = previous?.requestedModel || laneId;
  if (!turn || !previous?.error) return notify("This generation is no longer retryable.");
  const oldCard = byId("chat-messages").querySelectorAll(".sandbox-results")[turnIndex]?.querySelector(`[data-sandbox-lane="${CSS.escape(laneId)}"]`);
  if (!oldCard) return notify("Could not locate the failed result card.");
  const holder = document.createElement("article"); holder.className = "sandbox-result pending"; holder.dataset.sandboxModel = model; holder.innerHTML = `<header><strong></strong><span class="status-pill">RETRYING</span></header><div class="content sandbox-pending">Retrying the same prompt with the original turn settings...</div><div class="sandbox-progress" role="progressbar"><i></i><span class="sandbox-progress-metrics"><b>IN FLIGHT</b><b>estimating tokens</b><b>estimating tok/s</b></span></div>`; holder.querySelector("strong").textContent = model; oldCard.replaceWith(holder);
  const retryMetrics = holder.querySelectorAll(".sandbox-progress-metrics b");
  workspace.pendingCards.set(laneId, { card: holder, progress: holder.querySelector(".sandbox-progress"), elapsed: retryMetrics[0], tokens: retryMetrics[1], rate: retryMetrics[2], model });
  workspace.busy = true; workspace.controller = new AbortController(); renderArenaStatus(); byId("send-chat").disabled = true; byId("stop-chat").hidden = false;
  let result;
  try {
    const response = await fetch("/admin/api/sandbox", { method: "POST", headers: headers(true), signal: workspace.controller.signal, body: JSON.stringify({ purpose: turn.mode, requests: [{ id: `retry_${Date.now()}`, model, messages: sandboxMessagesForTurn(laneId, model, turnIndex, workspace), parameters: turn.parameters }] }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    result = payload.results?.[0] || { requestedModel: model, content: "", reasoning: "", error: "Model returned no result", metrics: null, parameters: turn.parameters };
  } catch (error) {
    result = { requestedModel: model, content: "", reasoning: "", error: error.name === "AbortError" ? "Cancelled" : error.message, metrics: null, parameters: turn.parameters };
  } finally {
    workspace.pendingCards.delete(laneId);
    workspace.busy = false; workspace.controller = null;
  }
  result.starred = Boolean(previous.starred);
  result.laneId = laneId;
  result.laneLabel = previous.laneLabel;
  turn.results[laneId] = result;
  workspace.status = result.error ? "failed" : "ready";
  if (workspace === activeWorkspace()) holder.replaceWith(sandboxResultCard(result, turn.mode, { turnIndex }));
  await saveSandboxRun(workspace).catch((error) => notify(`Retry could not be saved: ${error.message}`));
  if (workspace === activeWorkspace()) renderActiveWorkspace();
}

async function renderSandboxLibrary() {
  const list = byId("sandbox-library-list");
  list.replaceChildren();
  let runs;
  try {
    runs = await listSandboxRuns();
  } catch (error) {
    const failure = document.createElement("p");
    failure.className = "sandbox-library-error";
    failure.textContent = `Saved runs could not be loaded from this browser: ${error.message}`;
    list.append(failure);
    return;
  }
  if (state.sandboxLibraryStarredOnly) runs = runs.filter((run) => (run.turns || []).some((turn) => Object.values(turn.results || {}).some((result) => result.starred)));
  if (!runs.length) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = state.sandboxLibraryStarredOnly ? "No starred saved runs." : "No saved Support runs or legacy archives.";
    list.append(empty);
    return;
  }
  for (const run of runs) {
    const row = document.createElement("article");
    row.className = "sandbox-library-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sandbox-library-open";
    button.dataset.runId = run.id;
    const title = document.createElement("strong");
    const runLabel = run.mode === "diagnose" ? "SUPPORT" : `LEGACY ${String(run.mode || "UNKNOWN").toUpperCase()} ARCHIVE`;
    title.textContent = `${runLabel} / ${(run.models || []).length} MODEL${(run.models || []).length === 1 ? "" : "S"}`;
    const meta = document.createElement("span");
    const turns = run.turns || [];
    const stars = turns.reduce((total, turn) => total + Object.values(turn.results || {}).filter((result) => result.starred).length, 0);
    meta.textContent = `${new Date(run.updatedAt).toLocaleString()} / ${turns.length} TURN${turns.length === 1 ? "" : "S"}${stars ? ` / ★ ${stars}` : ""}`;
    const prompt = document.createElement("small");
    prompt.textContent = turns.at(-1)?.prompt || run.assistantPlan?.request || "No prompt";
    button.append(title, meta, prompt);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button secondary";
    remove.dataset.deleteRun = run.id;
    remove.textContent = "DELETE";
    row.append(button, remove);
    list.append(row);
  }
}

async function setSandboxLibraryOpen(open) {
  if (open) stopTts();
  state.sandboxLibraryOpen = open;
  byId("sandbox-library").classList.toggle("hidden", !open);
  byId("chat-messages").classList.toggle("hidden", open);
  byId("sandbox-settings").classList.toggle("hidden", open);
  byId("chat-form").classList.toggle("hidden", open);
  if (open) await renderSandboxLibrary();
}

async function openSavedRun(id) {
  const run = await sandboxStore("readonly", (store) => store.get(id));
  if (!run) return notify("Saved run is unavailable.");
  const workspace = state.arenaWorkspaces.diagnose;
  if (workspace.busy) return notify("Support is still running. Stop it before opening another saved run.");
  stopTts();
  setSandboxMode("diagnose", true);
  workspace.runId = run.mode === "diagnose" ? run.id : crypto.randomUUID();
  workspace.turns = structuredClone(run.turns || []);
  workspace.selectedModels = new Set((run.models || []).slice(0, 4));
  workspace.modelLineup = (run.modelLineup || run.models || []).filter((model) => typeof model === "string").slice(0, 4);
  workspace.assistantPlan = run.assistantPlan ? structuredClone(run.assistantPlan) : null;
  workspace.configProposal = run.configProposal ? structuredClone(run.configProposal) : null;
  if (workspace.configProposal) workspace.configProposal.requiresRevalidation = true;
  workspace.draft = typeof run.draft === "string" ? run.draft : "";
  workspace.status = "ready";
  const latestParameters = (run.turns || []).at(-1)?.parameters || {};
  workspace.parameters = run.parameters || {
    providerDefaultMax: latestParameters.maxTokens == null,
    maxTokens: latestParameters.maxTokens ?? 4096,
    temperature: latestParameters.temperature ?? "",
    topP: latestParameters.topP ?? ""
  };
  renderActiveWorkspace();
  await setSandboxLibraryOpen(false);
  byId("chat-route").textContent = `${run.mode === "diagnose" ? "SAVED SUPPORT" : "LEGACY ARCHIVE"} / ${workspace.turns.length} TURN${workspace.turns.length === 1 ? "" : "S"}`;
  persistArenaWorkspaces();
}

async function restoreArenaWorkspaces() {
  await Promise.all(ARENA_MODES.map(async (mode) => {
    const workspace = state.arenaWorkspaces[mode];
    const run = await sandboxStore("readonly", (store) => store.get(workspace.runId)).catch(() => null);
    if (!run || run.mode !== mode) return;
    workspace.turns = structuredClone(run.turns || []);
    workspace.assistantPlan = run.assistantPlan ? structuredClone(run.assistantPlan) : null;
    workspace.configProposal = run.configProposal ? structuredClone(run.configProposal) : null;
    if (workspace.configProposal) workspace.configProposal.requiresRevalidation = true;
    if (!workspace.selectedModels.size) workspace.selectedModels = new Set((run.models || []).slice(0, 4));
    if (!workspace.modelLineup.length) workspace.modelLineup = (run.modelLineup || run.models || []).filter((model) => typeof model === "string").slice(0, 4);
    if (!storedArena?.workspaces?.[mode]?.parameters) {
      const latest = (run.turns || []).at(-1)?.parameters || {};
      workspace.parameters = run.parameters || { providerDefaultMax: latest.maxTokens == null, maxTokens: latest.maxTokens ?? 4096, temperature: latest.temperature ?? "", topP: latest.topP ?? "" };
    }
  }));
}

const PROPOSAL_FIELDS = {
  maxAttempts: ["Max attempts", "number", 1, 5], requestTimeoutMs: ["Request deadline / ms", "number", 5000, 600000], firstEventTimeoutMs: ["First output / ms", "number", 1000, 120000], slowModelFirstEventTimeoutMs: ["Slow-model first output / ms", "number", 5000, 180000], streamIdleTimeoutMs: ["Stream idle / ms", "number", 5000, 300000], catalogRefreshHours: ["Catalog refresh / hours", "number", 1, 168], circuitFailureThreshold: ["Circuit failures", "number", 1, 20], circuitMinimumSamples: ["Circuit minimum samples", "number", 1, 100], circuitWindowSize: ["Circuit window", "number", 2, 200], circuitOpenMs: ["Circuit open / ms", "number", 1000, 3600000],
  fallbackExplicitModels: ["Fall back explicit models", "boolean"], thinkingFallbackMode: ["Thinking fallback", "enum"], openaiOrder: ["OpenAI order", "array"], anthropicOrder: ["Anthropic order", "array"], paidOpenRouterFallbackOrder: ["Paid OpenRouter fallback order", "array"], freeModelOrder: ["Free order", "array"], disabledModels: ["Disabled models", "array"], enabledExternalModels: ["Enabled external models", "array"], dashboardModel: ["Dashboard model", "text"], customCascades: ["Custom cascades", "json"]
};

function proposalControl(field, value) {
  const schema = PROPOSAL_FIELDS[field] || [field, "json"];
  const label = document.createElement("label"); label.className = `proposal-field proposal-${schema[1]}`;
  const heading = document.createElement("span"); heading.textContent = schema[0];
  let control;
  if (schema[1] === "boolean") { control = document.createElement("input"); control.type = "checkbox"; control.checked = value === true; }
  else if (schema[1] === "enum") { control = document.createElement("select"); control.append(new Option("Strip thinking for fallback", "strip"), new Option("Pin physical Claude model", "pin")); control.value = value; }
  else if (schema[1] === "number") { control = document.createElement("input"); control.type = "number"; control.required = true; control.min = String(schema[2]); control.max = String(schema[3]); control.step = "1"; control.value = String(value); }
  else if (schema[1] === "array") { control = document.createElement("textarea"); control.rows = Math.min(10, Math.max(3, value.length + 1)); control.value = value.join("\n"); }
  else if (schema[1] === "json") { control = document.createElement("textarea"); control.rows = 8; control.value = JSON.stringify(value, null, 2); }
  else { control = document.createElement("input"); control.type = "text"; control.required = true; control.value = String(value); }
  control.dataset.proposalField = field; control.dataset.proposalType = schema[1]; label.append(heading, control); return label;
}

function proposalPatchFromEditor(card) {
  const patch = {};
  for (const control of card.querySelectorAll("[data-proposal-field]")) {
    if (!control.reportValidity()) throw new Error(`Correct ${control.dataset.proposalField} before revalidating`);
    const type = control.dataset.proposalType;
    patch[control.dataset.proposalField] = type === "boolean" ? control.checked : type === "number" ? control.valueAsNumber : type === "array" ? control.value.split("\n").map((value) => value.trim()).filter(Boolean) : type === "json" ? JSON.parse(control.value) : control.value.trim();
  }
  return patch;
}

function renderConfigProposal(proposal, workspace = activeWorkspace()) {
  workspace.configProposal = proposal;
  if (workspace !== activeWorkspace()) return;
  const host = byId("config-proposal-host");
  byId("chat-messages").append(host);
  host.replaceChildren();
  const card = document.createElement("article");
  card.className = "config-proposal";
  const heading = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "PROPOSED / NOT APPLIED";
  const expiry = document.createElement("span");
  expiry.textContent = `Expires ${new Date(proposal.expiresAt).toLocaleTimeString()}`;
  heading.append(title, expiry);
  const summary = document.createElement("h3");
  summary.textContent = proposal.summary;
  const rationale = document.createElement("p");
  rationale.textContent = proposal.rationale;
  const editor = document.createElement("div");
  editor.id = "proposal-patch-editor";
  editor.className = "proposal-editor";
  for (const [field, value] of Object.entries(proposal.patch)) editor.append(proposalControl(field, value));
  const requiresRevalidation = proposal.requiresRevalidation === true || Number(proposal.expiresAt) <= Date.now();
  const validation = document.createElement("p");
  validation.className = `proposal-validation-status${requiresRevalidation ? " required" : ""}`;
  validation.textContent = requiresRevalidation ? "Restored proposal requires server revalidation before approval." : "Server validated. Ready for review.";
  const changes = document.createElement("div");
  changes.className = "proposal-changes";
  for (const change of proposal.changes) {
    const row = document.createElement("p");
    row.textContent = `${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
    changes.append(row);
  }
  const actions = document.createElement("div");
  actions.className = "proposal-actions";
  for (const [text, action, primary] of [["DISCARD", "discard", false], ["REVALIDATE EDITS", "validate", false], ["REVIEW & APPLY", "apply", true]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${primary ? "primary-button" : "secondary"}`;
    button.dataset.proposalAction = action;
    button.textContent = text;
    if (action === "apply" && requiresRevalidation) button.disabled = true;
    actions.append(button);
  }
  card.append(heading, summary, rationale, editor, validation, changes, actions);
  host.append(card);
  editor.addEventListener("input", () => {
    card.dataset.proposalDirty = "true";
    const apply = card.querySelector('[data-proposal-action="apply"]'); if (apply) apply.disabled = true;
    validation.className = "proposal-validation-status required"; validation.textContent = "Edits require server revalidation before approval.";
  });
}

async function askForConfigProposal(prompt, workspace = activeWorkspace(), intent = "configure") {
  const model = [...workspace.selectedModels][0];
  if (!model) return notify("Select a model to act as the configuration advisor.");
  if (!prompt) return notify("Describe the configuration change you want proposed.");
  const framedPrompt = intent === "optimize"
    ? `Optimization objective: Review router policy for measurable reliability, latency, and cost improvements. Propose only justified, bounded changes.\n\nUser request: ${prompt}`
    : `Configuration objective: Produce an editable, validated router configuration proposal matching this request.\n\nUser request: ${prompt}`;
  const button = byId("propose-config");
  const pending = workspace === activeWorkspace() ? chatBubble("assistant", `${intent.toUpperCase()} / Analyzing current policy and preparing an editable proposal...`) : null;
  pending?.article.classList.add("pending");
  workspace.busy = true;
  workspace.status = "running";
  renderArenaStatus();
  if (workspace === activeWorkspace()) { button.disabled = true; byId("send-chat").disabled = true; byId("chat-route").textContent = `${intent.toUpperCase()} / ${model}`; }
  try {
    const payload = await api("/admin/api/config/proposals/generate", {
      method: "POST",
      body: JSON.stringify({ model, prompt: framedPrompt })
    });
    workspace.configProposal = payload.proposal;
    workspace.turns.push({ prompt: `${intent.toUpperCase()}: ${prompt}`, mode: "diagnose", parameters: {}, results: { [model]: { requestedModel: model, content: `Proposal prepared by ${payload.advisorModel || model}. Review or modify each setting below, then revalidate before approval.`, reasoning: "", error: null, metrics: null, parameters: {} } } });
    workspace.draft = "";
    workspace.status = "ready";
    await saveSandboxRun(workspace).catch((error) => notify(`Proposal could not be saved locally: ${error.message}`));
    if (workspace === activeWorkspace()) renderActiveWorkspace();
    notify("Configuration proposal generated. It has not been applied.", true);
  } catch (error) {
    workspace.status = "failed";
    if (pending) { pending.text.textContent = `Could not generate a configuration proposal: ${error.message}`; pending.article.classList.remove("pending"); pending.article.classList.add("failed"); }
    notify(error.message);
  } finally {
    workspace.busy = false;
    persistArenaWorkspaces();
    if (workspace === activeWorkspace()) { button.disabled = false; byId("send-chat").disabled = false; renderArenaStatus(); }
  }
}

function assistantIntent(message) {
  const text = message.toLowerCase();
  const explainOnly = /\b(do not|don't|dont|without)\s+(change|modify|apply|update)|\b(explain only|just explain|no changes?)\b/.test(text);
  const configuration = /\b(config(?:uration|ure)?|settings?|routing policy|fallback|timeouts?|circuits?|cascades?|model orders?|free order|queues?|max(?:imum)? attempts?|dashboard model|enabled models?|disabled models?)\b/.test(text);
  const optimize = /\b(optimi[sz]e|tune|reduce (?:cost|latency|failures?)|improve (?:routing|reliability|performance))\b/.test(text);
  const propose = /\b(suggest|propose|recommend|change|adjust|update|set|add|remove|enable|disable|create|delete|replace|reorder|increase|decrease|fix|configure|turn on|turn off)\b/.test(text);
  if (!explainOnly && configuration && optimize) return "optimize";
  if (!explainOnly && configuration && (propose || /\bconfiguration changes?\b/.test(text))) return "config";
  return "respond";
}

function renderAssistantPlan(plan) {
  const card = document.createElement("article");
  card.className = "assistant-plan";
  const title = document.createElement("strong");
  title.textContent = `LEGACY COMPARISON PLAN / ${String(plan.mode || "chat").toUpperCase()} / NOT RUN`;
  const rationale = document.createElement("p");
  rationale.textContent = plan.rationale;
  const lineup = document.createElement("p");
  lineup.textContent = `Lineup: ${(plan.models || []).join(" > ")}`;
  const summary = document.createElement("p");
  const providers = Array.isArray(plan.providerDestinations) ? [...new Set(plan.providerDestinations.map((destination) => destination?.provider).filter(Boolean))] : [];
  summary.textContent = `${(plan.models || []).length} independent lane${(plan.models || []).length === 1 ? "" : "s"} / cost ${String(plan.costClass || "unknown").toUpperCase()}${providers.length ? ` / destinations ${providers.join(", ")}` : ""}`;
  const prompt = document.createElement("pre");
  prompt.textContent = plan.prompt;
  const warnings = document.createElement("ul");
  warnings.className = "assistant-plan-warnings";
  for (const warning of Array.isArray(plan.warnings) ? plan.warnings : []) {
    const item = document.createElement("li");
    item.textContent = warning;
    warnings.append(item);
  }
  const archiveNote = document.createElement("p");
  archiveNote.textContent = "This dashboard no longer opens Chat or Design workspaces. Use Model Fieldbook for model comparisons.";
  card.append(title, rationale, lineup, summary);
  if (warnings.childElementCount) card.append(warnings);
  card.append(prompt, archiveNote);
  byId("chat-messages").append(card);
}

async function runAssistantComparison(modeHint, message, workspace = activeWorkspace()) {
  const advisorModel = [...workspace.selectedModels][0];
  if (!advisorModel) return notify("Select at least one advisor model first.");
  const pending = workspace === activeWorkspace() ? chatBubble("assistant", "Planning only: selecting a lineup, settings, and focused prompt. Nothing will run automatically.") : null;
  pending?.article.classList.add("pending");
  workspace.busy = true; workspace.status = "running";
  if (workspace === activeWorkspace()) byId("send-chat").disabled = true;
  renderArenaStatus();
  let plan;
  try {
    const payload = await api("/admin/api/assistant/plan", { method: "POST", body: JSON.stringify({ advisorModel, request: message, modeHint }) });
    plan = payload.plan;
  } catch (error) {
    workspace.status = "failed";
    if (pending) { pending.text.textContent = `Could not plan the comparison: ${error.message}`; pending.article.classList.remove("pending"); pending.article.classList.add("failed"); }
    notify(error.message);
    return;
  } finally {
    workspace.busy = false;
    if (workspace === activeWorkspace()) byId("send-chat").disabled = false;
    persistArenaWorkspaces();
  }
  workspace.assistantPlan = { request: message, advisorModel, ...plan };
  workspace.draft = "";
  workspace.status = "ready";
  await saveSandboxRun(workspace).catch((error) => notify(`Plan could not be saved locally: ${error.message}`));
  if (workspace === activeWorkspace()) renderActiveWorkspace();
  notify(`Plan ready. Choose a destination; no comparison has run.`, true);
}

async function load(silent = false) {
  if (state.statusLoadBusy) return;
  state.statusLoadBusy = true;
  try {
    const payload = await api("/admin/api/status");
    render(payload);
    state.lastSuccessfulLoad = Date.now();
    setConnectionState(document.visibilityState === "visible" ? "online" : "paused");
    state.historyUnavailable = payload.runtime.historyAvailable !== true;
    if (state.historyUnavailable) {
      byId("history-retained").textContent = "HISTORY API UNAVAILABLE / RESTART REQUIRED";
      renderHistory();
    } else if (state.historyRequestCount !== payload.metrics.totals.requests) {
      await loadHistory();
    }
  } catch (error) {
    setConnectionState(document.visibilityState === "visible" ? "offline" : "paused");
    if (!silent && !String(error.message).includes("authentication")) notify(error.message);
  } finally {
    state.statusLoadBusy = false;
  }
}

async function refreshDashboard() {
  const button = byId("refresh-status");
  if (button?.disabled) return;
  const label = button?.textContent || "REFRESH";
  if (button) {
    button.disabled = true;
    button.textContent = "REFRESHING...";
    button.setAttribute("aria-busy", "true");
  }
  try {
    while (state.statusLoadBusy) await new Promise((resolve) => setTimeout(resolve, 25));
    await load(false);
    await loadHistory(true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
      button.removeAttribute("aria-busy");
    }
  }
}

function lines(id) {
  return byId(id).value.split("\n").map((line) => line.trim()).filter(Boolean);
}

const CONFIG_NUMBER_FIELDS = ["maxAttempts", "requestTimeoutMs", "firstEventTimeoutMs", "slowModelFirstEventTimeoutMs", "streamIdleTimeoutMs", "circuitFailureThreshold", "circuitOpenMs", "circuitWindowSize", "circuitMinimumSamples", "catalogRefreshHours"];

const CONFIG_DIRTY_FIELDS = new Set([...CONFIG_NUMBER_FIELDS, "fallbackExplicitModels", "thinkingFallbackMode", "openaiOrder", "anthropicOrder", "paidOpenRouterFallbackOrder", "freeModelOrder", "disabledModels", "enabledExternalModels"]);

byId("config-form").addEventListener("input", (event) => {
  if (CONFIG_DIRTY_FIELDS.has(event.target.id)) state.configDirty = true;
});
byId("config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const invalid = CONFIG_NUMBER_FIELDS.map((id) => byId(id)).find((input) => !input.checkValidity());
  if (invalid) {
    invalid.reportValidity();
    return;
  }
  const button = byId("save-config");
  button.disabled = true;
  try {
    const numberValues = Object.fromEntries(CONFIG_NUMBER_FIELDS.map((id) => [id, byId(id).valueAsNumber]));
    if (Object.values(numberValues).some((value) => !Number.isFinite(value))) {
      form.reportValidity();
      return;
    }
    await api("/admin/api/config", {
      method: "PATCH",
      headers: state.status?.configRevision ? { "x-config-revision": state.status.configRevision } : {},
      body: JSON.stringify({
        ...numberValues,
        fallbackExplicitModels: byId("fallbackExplicitModels").checked,
        thinkingFallbackMode: byId("thinkingFallbackMode").value,
        openaiOrder: lines("openaiOrder"),
        anthropicOrder: lines("anthropicOrder"),
        paidOpenRouterFallbackOrder: lines("paidOpenRouterFallbackOrder"),
        freeModelOrder: lines("freeModelOrder"),
        disabledModels: lines("disabledModels"),
        enabledExternalModels: lines("enabledExternalModels"),
        dashboardModel: state.status?.config?.dashboardModel || "auto"
        ,customCascades: structuredClone(state.configDraft.customCascades)
      })
    });
    state.configDirty = false;
    notify("Routing policy applied.", true);
    await load(true);
    setConfigOpen(false, { discardDirty: true });
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

for (const id of ["model-search", "model-provider-filter", "model-protocol-filter", "model-modality-filter", "model-state-filter", "model-order-filter", "model-free-only", "model-price-basis", "model-price-min", "model-price-max", "model-sort", "model-sort-direction"]) {
  byId(id)?.addEventListener(["model-search", "model-price-min", "model-price-max"].includes(id) ? "input" : "change", () => { state.showAllModels = false; renderModelRows(); });
}
byId("model-show-all")?.addEventListener("click", () => { state.showAllModels = !state.showAllModels; renderModelRows(); });
byId("create-custom-cascade")?.addEventListener("click", () => {
  const input = byId("custom-cascade-name"); const name = input.value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return notify("Queue names use lowercase letters, numbers, dot, underscore, or dash.");
  if (state.configDraft.customCascades.some((cascade) => cascade.name === name)) return notify("That queue name already exists.");
  const members = [...state.selectedModels];
  if (!members.length) return notify("Select at least one physical model before creating a queue.");
  state.configDraft.customCascades.push({ name, members }); input.value = ""; setDraftDirty(); renderCustomCascades();
});
byId("custom-cascade-list")?.addEventListener("input", (event) => {
  const name = event.target.dataset.cascadeMembers; if (!name) return;
  const cascade = state.configDraft.customCascades.find((entry) => entry.name === name);
  if (cascade) { cascade.members = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); setDraftDirty(); }
});
byId("custom-cascade-list")?.addEventListener("click", (event) => {
  const add = event.target.closest("[data-cascade-add-selected]")?.dataset.cascadeAddSelected;
  const remove = event.target.closest("[data-cascade-delete]")?.dataset.cascadeDelete;
  if (add) {
    const cascade = state.configDraft.customCascades.find((entry) => entry.name === add);
    if (cascade) for (const id of state.selectedModels) if (!cascade.members.includes(id)) cascade.members.push(id);
  } else if (remove) state.configDraft.customCascades = state.configDraft.customCascades.filter((entry) => entry.name !== remove);
  else return;
  setDraftDirty(); renderCustomCascades();
});

byId("model-browser")?.addEventListener("change", (event) => {
  const selected = event.target.dataset.selectModel;
  if (selected) {
    if (event.target.checked) state.selectedModels.add(selected); else state.selectedModels.delete(selected);
    renderModelRows();
    return;
  }
  const toggled = event.target.dataset.toggleModel;
  if (toggled) {
    const model = catalogModels().find((entry) => entry.id === toggled);
    if (!model) return;
    const disabled = new Set(state.configDraft.disabledModels);
    const enabledExternal = new Set(state.configDraft.enabledExternalModels);
    if (event.target.checked) {
      disabled.delete(toggled);
      if (isExternalModel(model) && !isFreeExternalModel(model)) enabledExternal.add(toggled);
    } else if (isExternalModel(model) && !isFreeExternalModel(model)) {
      enabledExternal.delete(toggled);
    } else {
      disabled.add(toggled);
    }
    state.configDraft.disabledModels = [...disabled];
    state.configDraft.enabledExternalModels = [...enabledExternal];
    setDraftDirty();
    renderModelRows();
  }
});
byId("model-browser")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-model-detail]");
  if (!button) return;
  state.selectedModelId = button.dataset.modelDetail;
  renderModelDetail(catalogModels().find((model) => model.id === state.selectedModelId));
});
byId("model-select-all")?.addEventListener("change", (event) => {
  const matching = filteredModels();
  for (const model of state.showAllModels ? matching : matching.slice(0, 200)) {
    if (event.target.checked) state.selectedModels.add(model.id); else state.selectedModels.delete(model.id);
  }
  renderModelRows();
});

function bulkSetEnabled(enabled) {
  const disabled = new Set(state.configDraft.disabledModels);
  const enabledExternal = new Set(state.configDraft.enabledExternalModels);
  for (const id of state.selectedModels) {
    const model = catalogModels().find((entry) => entry.id === id);
    if (!model) continue;
    if (enabled) {
      disabled.delete(id);
      if (isExternalModel(model) && !isFreeExternalModel(model)) enabledExternal.add(id);
    } else if (isExternalModel(model) && !isFreeExternalModel(model)) {
      enabledExternal.delete(id);
    } else {
      disabled.add(id);
    }
  }
  state.configDraft.disabledModels = [...disabled];
  state.configDraft.enabledExternalModels = [...enabledExternal];
  setDraftDirty();
  renderModelRows();
}
byId("models-enable")?.addEventListener("click", () => bulkSetEnabled(true));
byId("models-disable")?.addEventListener("click", () => bulkSetEnabled(false));
for (const protocol of ["openai", "anthropic", "paid-openrouter", "free"]) {
  byId(`models-add-${protocol}`)?.addEventListener("click", () => {
    const key = orderConfigKey(protocol);
    for (const model of catalogModels()) {
      const compatible = protocol === "free" ? isFreeExternalModel(model) : protocol === "paid-openrouter" ? modelProvider(model) === "openrouter" && !isFreeExternalModel(model) : modelSupports(model, protocol);
      if (state.selectedModels.has(model.id) && compatible && !state.configDraft[key].includes(model.id)) state.configDraft[key].push(model.id);
    }
    setDraftDirty();
    renderModelManager();
  });
  byId(`${protocol}-order-list`)?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-order-action]");
    const item = event.target.closest("[data-order-model]");
    if (!button || !item) return;
    const actions = { top: "top", up: -1, down: 1, bottom: "bottom", remove: "remove" };
    moveOrder(protocol, item.dataset.orderModel, actions[button.dataset.orderAction]);
  });
  byId(`${protocol}-order-list`)?.addEventListener("keydown", (event) => {
    const item = event.target.closest("[data-order-model]");
    if (!item || !event.altKey) return;
    const action = { ArrowUp: -1, ArrowDown: 1, Home: "top", End: "bottom", Delete: "remove" }[event.key];
    if (action === undefined) return;
    event.preventDefault();
    moveOrder(protocol, item.dataset.orderModel, action);
  });
}

async function refreshProvider(providerId, kind, button) {
  button.disabled = true;
  try {
    const path = kind === "credits"
      ? `/admin/api/providers/credits/refresh?provider=${encodeURIComponent(providerId)}`
      : `/admin/api/catalog/refresh?provider=${encodeURIComponent(providerId)}`;
    await api(path, { method: "POST", body: "{}" });
    notify(`${providerId} ${kind} refreshed.`, true);
    await load(true);
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}
byId("provider-cards")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-provider-action]");
  if (button) void refreshProvider(button.dataset.providerId, button.dataset.providerAction, button);
});
byId("refresh-provider-credits")?.addEventListener("click", async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try { await api("/admin/api/providers/credits/refresh", { method: "POST", body: "{}" }); notify("Provider credits refreshed.", true); await load(true); }
  catch (error) { notify(error.message); } finally { button.disabled = false; }
});

byId("refresh-catalog").addEventListener("click", async () => {
  const button = byId("refresh-catalog");
  button.disabled = true;
  try {
    await api("/admin/api/catalog/refresh", { method: "POST", body: "{}" });
    notify("RouteTok catalog refreshed.", true);
    await load(true);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

byId("reset-circuits").addEventListener("click", async () => {
  if (!confirm("Reset all circuit, rate-limit, and entitlement state?")) return;
  try {
    await api("/admin/api/circuits/reset", { method: "POST", body: "{}" });
    notify("Health state reset.", true);
    await load(true);
  } catch (error) {
    notify(error.message);
  }
});

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = byId("dashboard-token").value;
  localStorage.setItem("routetok-dashboard-token", state.token);
  byId("auth-dialog").close();
  await load();
  if (state.apiAccessOpen) await loadClientKeys();
});

function setPageInert(overlay, scrim, inert) {
  if (!overlay) return;
  if (!inert) {
    for (const child of state.modalInerted) child.inert = false;
    state.modalInerted = [];
    return;
  }
  for (const child of document.body.children) {
    if (child.contains(overlay)) {
      for (const nested of child.children) {
        if (nested === overlay || nested === scrim || nested.contains(overlay) || nested.contains(scrim) || nested.inert) continue;
        nested.inert = true;
        state.modalInerted.push(nested);
      }
      continue;
    }
    if (child === overlay || child === scrim || child === byId("command-palette") || child.tagName === "SCRIPT" || child.tagName === "DIALOG" || child.inert) continue;
    child.inert = true;
    state.modalInerted.push(child);
  }
}

function focusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function setChatOpen(open) {
  if (open && state.configOpen && !setConfigOpen(false)) return false;
  if (open) {
    setCustomizeOpen(false);
    setApiAccessOpen(false);
  }
  state.chatOpen = open;
  if (open) state.chatReturnFocus = document.activeElement;
  document.body.classList.toggle("chat-open", open);
  const drawer = byId("chat-drawer");
  drawer.inert = !open;
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  byId("open-chat")?.setAttribute("aria-expanded", String(open));
  byId("open-sandbox")?.setAttribute("aria-expanded", String(open));
  byId("open-assistant")?.setAttribute("aria-expanded", String(open));
  if (!open) {
    stopRecorder(false, "RECORDING DISCARDED / ARENA CLOSED");
    audioState.sttController?.abort();
    stopTts();
    if (byId("transcript-review-dialog").open) byId("transcript-review-dialog").close("arena-closed");
  }
  if (open) {
    void loadAudioCapabilities().catch(() => {});
    renderActiveWorkspace();
    byId("chat-input").focus();
    const container = byId("chat-messages");
    container.scrollTop = activeWorkspace().scrollTop || container.scrollHeight;
  } else if (document.activeElement?.closest("#chat-drawer")) {
    (state.chatReturnFocus?.isConnected ? state.chatReturnFocus : byId("open-chat"))?.focus();
    state.chatReturnFocus = null;
  }
  return true;
}

function setCustomizeOpen(open) {
  const drawer = byId("customize-drawer");
  const scrim = byId("customize-scrim");
  if (!drawer) return;
  if (open === state.customizeOpen) return;
  if (open) {
    if (state.configOpen && !setConfigOpen(false)) return;
    setApiAccessOpen(false);
    setChatOpen(false);
    state.customizeReturnFocus = document.activeElement;
    state.customizePreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  state.customizeOpen = open;
  drawer.inert = !open;
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  drawer.setAttribute("aria-modal", String(open));
  if (!drawer.hasAttribute("role")) drawer.setAttribute("role", "dialog");
  scrim?.classList.toggle("open", open);
  scrim?.setAttribute("aria-hidden", String(!open));
  byId("open-customize")?.setAttribute("aria-expanded", String(open));
  setPageInert(drawer, scrim, open);
  if (open) {
    syncPreferenceControls();
    (focusableElements(drawer)[0] || drawer).focus();
  } else {
    document.body.style.overflow = state.customizePreviousOverflow || "";
    state.customizePreviousOverflow = null;
    if (state.customizeReturnFocus?.isConnected) state.customizeReturnFocus.focus();
    state.customizeReturnFocus = null;
  }
}

function setApiAccessOpen(open) {
  const drawer = byId("api-access"); const scrim = byId("api-access-scrim");
  if (!drawer || open === state.apiAccessOpen) return;
  if (open) {
    if (state.configOpen && !setConfigOpen(false)) return;
    setCustomizeOpen(false); setChatOpen(false);
    state.apiAccessReturnFocus = document.activeElement;
    state.apiAccessPreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  state.apiAccessOpen = open;
  drawer.inert = !open; drawer.classList.toggle("open", open); drawer.setAttribute("aria-hidden", String(!open));
  scrim?.classList.toggle("open", open); scrim?.setAttribute("aria-hidden", String(!open));
  byId("open-api-access")?.setAttribute("aria-expanded", String(open));
  setPageInert(drawer, scrim, open);
  if (open) {
    void loadClientKeys();
    byId("api-access-title").focus();
  } else {
    document.body.style.overflow = state.apiAccessPreviousOverflow || "";
    state.apiAccessPreviousOverflow = null;
    if (state.apiAccessReturnFocus?.isConnected) state.apiAccessReturnFocus.focus();
    state.apiAccessReturnFocus = null;
  }
}

function setConfigOpen(open, { discardDirty = false } = {}) {
  const drawer = byId("config-drawer");
  const scrim = byId("config-scrim");
  if (open === state.configOpen) return true;
  if (!open && state.configDirty && !discardDirty && !confirm("Discard unapplied Settings changes?")) return false;
  if (open) {
    setCustomizeOpen(false);
    setApiAccessOpen(false);
    setChatOpen(false);
    state.configReturnFocus = document.activeElement;
    state.configPreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  state.configOpen = open;
  if (open && state.status?.config) {
    state.configDirty = false;
    fillConfig(state.status.config);
  }
  drawer.inert = !open;
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  byId("open-config")?.setAttribute("aria-expanded", String(open));
  scrim.classList.toggle("open", open);
  scrim.setAttribute("aria-hidden", String(!open));
  setPageInert(drawer, scrim, open);
  if (open) byId("config-title").focus();
  else {
    state.configDirty = false;
    state.configDraft = null;
    state.selectedModels.clear();
    document.body.style.overflow = state.configPreviousOverflow || "";
    state.configPreviousOverflow = null;
    if (state.configReturnFocus?.isConnected) state.configReturnFocus.focus();
    state.configReturnFocus = null;
  }
  return true;
}

function setRailExpanded(expanded) {
  state.railExpanded = expanded;
  byId("inflight-rail")?.classList.toggle("expanded", expanded);
  byId("toggle-inflight-rail")?.setAttribute("aria-expanded", String(expanded));
  if (expanded) byId("close-inflight-rail")?.focus();
}

function applyInflightPlacement(placement) {
  const rail = byId("inflight-rail");
  const slot = byId("inflight-main-slot");
  const anchor = byId("inflight-rail-anchor");
  if (!rail || !slot || !anchor) return;
  if (placement === "main") slot.append(rail);
  else anchor.after(rail);
  rail.dataset.placement = placement;
}

function persistSectionLayout() {
  try {
    localStorage.setItem(SECTION_LAYOUT_KEY, JSON.stringify([...state.collapsedSections]));
  } catch {}
}

function setSectionCollapsed(key, collapsed, persist = true) {
  const definition = LAYOUT_SECTIONS.find((entry) => entry.key === key);
  const panel = definition ? document.querySelector(definition.selector) : null;
  if (!panel) return;
  panel.classList.toggle("section-collapsed", collapsed);
  const button = panel.querySelector("[data-section-collapse]");
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? "EXPAND" : "COLLAPSE";
  }
  if (collapsed) state.collapsedSections.add(key);
  else state.collapsedSections.delete(key);
  if (persist) persistSectionLayout();
}

function setupCollapsibleSections() {
  const saved = readStoredJson(localStorage, SECTION_LAYOUT_KEY);
  state.collapsedSections = new Set(Array.isArray(saved) ? saved.filter((key) => LAYOUT_SECTIONS.some((entry) => entry.key === key)) : []);
  for (const definition of LAYOUT_SECTIONS) {
    const panel = document.querySelector(definition.selector);
    const heading = panel?.querySelector(":scope > .panel-heading");
    if (!panel || !heading || panel.dataset.collapsibleReady === "true") continue;
    panel.dataset.collapsibleReady = "true";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary section-collapse-toggle";
    button.dataset.sectionCollapse = definition.key;
    button.setAttribute("aria-label", `Collapse or expand ${definition.label}`);
    button.addEventListener("click", () => setSectionCollapsed(definition.key, !state.collapsedSections.has(definition.key)));
    heading.append(button);
    const shell = document.createElement("div");
    shell.className = "collapsible-shell";
    const inner = document.createElement("div");
    inner.className = "collapsible-inner";
    for (const child of [...panel.children]) if (child !== heading) inner.append(child);
    shell.append(inner);
    panel.append(shell);
    setSectionCollapsed(definition.key, state.collapsedSections.has(definition.key), false);
  }
}

byId("collapse-all-sections")?.addEventListener("click", () => {
  for (const definition of LAYOUT_SECTIONS) setSectionCollapsed(definition.key, true, false);
  persistSectionLayout();
});
for (const menu of document.querySelectorAll(".masthead-menu")) {
  menu.addEventListener("click", (event) => {
    if (event.target.closest("button")) queueMicrotask(() => { menu.open = false; });
  });
}
byId("expand-all-sections")?.addEventListener("click", () => {
  for (const definition of LAYOUT_SECTIONS) setSectionCollapsed(definition.key, false, false);
  persistSectionLayout();
});
byId("reset-section-layout")?.addEventListener("click", () => {
  state.collapsedSections.clear();
  try { localStorage.removeItem(SECTION_LAYOUT_KEY); } catch {}
  for (const definition of LAYOUT_SECTIONS) setSectionCollapsed(definition.key, false, false);
  notify("Dashboard section layout reset.", true);
});
byId("toggle-inflight-rail")?.addEventListener("click", () => setRailExpanded(true));
byId("close-inflight-rail")?.addEventListener("click", () => setRailExpanded(false));

byId("open-config").addEventListener("click", () => setConfigOpen(true));
byId("close-config").addEventListener("click", () => setConfigOpen(false));
byId("config-scrim").addEventListener("click", () => setConfigOpen(false));
byId("open-customize")?.addEventListener("click", () => setCustomizeOpen(true));
byId("close-customize")?.addEventListener("click", () => setCustomizeOpen(false));
byId("customize-scrim")?.addEventListener("click", () => setCustomizeOpen(false));
byId("open-api-access")?.addEventListener("click", () => setApiAccessOpen(true));
byId("close-api-access")?.addEventListener("click", () => setApiAccessOpen(false));
byId("api-access-scrim")?.addEventListener("click", () => setApiAccessOpen(false));

const preferenceControls = [
  [["customize-theme", "theme-setting", "preference-theme", "theme-preference", "theme-select"], "theme"],
  [["customize-accent", "accent-setting", "preference-accent", "accent-color", "accent-picker"], "accent"],
  [["customize-density", "density-setting", "preference-density", "density-preference", "density-select"], "density"],
  [["customize-motion", "motion-setting", "preference-motion", "motion-preference", "motion-select"], "motion"],
  [["customize-glow", "glow-setting", "preference-glow", "glow-range", "glow-slider"], "glow"],
  [["customize-rail-side"], "inflightPlacement"],
  [["health-model-sort"], "dashboardModelSort"],
  [["health-model-sort-direction"], "dashboardModelSortDirection"]
];
for (const [ids, key] of preferenceControls) {
  const control = firstById(...ids);
  control?.addEventListener(control.tagName === "SELECT" ? "change" : "input", () => {
    updatePreference(key, key === "glow" ? Number(control.value) : control.value);
  });
}
for (const [key, entries] of Object.entries(PREFERENCE_BUTTONS)) {
  for (const [id, value] of Object.entries(entries)) byId(id)?.addEventListener("click", () => updatePreference(key, value));
  for (const button of document.querySelectorAll(`[data-preference="${key}"][data-value]`)) {
    if (!entries[button.id]) button.addEventListener("click", () => updatePreference(key, button.dataset.value));
  }
}
byId("health-model-options")?.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-health-model]");
  if (!checkbox) return;
  const hidden = new Set(state.preferences.hiddenDashboardModels);
  if (checkbox.checked) hidden.delete(checkbox.dataset.healthModel); else hidden.add(checkbox.dataset.healthModel);
  updatePreference("hiddenDashboardModels", [...hidden]);
});
byId("health-model-picker")?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-health-models]")?.dataset.healthModels;
  if (!action) return;
  const ids = [...byId("health-model-options").querySelectorAll("[data-health-model]")].map((checkbox) => checkbox.dataset.healthModel);
  updatePreference("hiddenDashboardModels", action === "all" ? [] : ids);
});
firstById("reset-preferences", "reset-customize", "reset-customization", "customize-reset")?.addEventListener("click", () => {
  localStorage.removeItem(PREFERENCES_KEY);
  applyPreferences(PREFERENCE_DEFAULTS);
  const status = byId("customize-status");
  if (status) status.textContent = "Customization reset.";
});
firstById("customize-accent-reset", "reset-accent", "clear-accent")?.addEventListener("click", () => updatePreference("accent", null));
byId("inflight-linger")?.addEventListener("input", (event) => updatePreference("completedLingerSeconds", Number(event.target.value)));

const configDrawer = byId("config-drawer");
const configResizeHandle = byId("config-resize-handle");
let configResizing = false;
let configResizeStartX = 0;
let configResizeStartWidth = 0;

configResizeHandle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  configResizing = true;
  configResizeStartX = event.clientX;
  configResizeStartWidth = configDrawer.offsetWidth;
  configResizeHandle.setPointerCapture(event.pointerId);
  document.body.style.cursor = "ew-resize";
  document.body.style.userSelect = "none";
});

configResizeHandle.addEventListener("pointermove", (event) => {
  if (!configResizing) return;
  const width = Math.max(360, Math.min(window.innerWidth - 24, configResizeStartWidth + configResizeStartX - event.clientX));
  configDrawer.style.width = `${width}px`;
});

configResizeHandle.addEventListener("pointerup", (event) => {
  if (!configResizing) return;
  configResizing = false;
  configResizeHandle.releasePointerCapture(event.pointerId);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

byId("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = byId("chat-input");
  const message = input.value.trim();
  if (!message) return;
  const workspace = activeWorkspace();
  workspace.draft = input.value;
  if (state.sandboxMode === "diagnose") {
    const intent = workspace.intent === "auto" ? assistantIntent(message) : workspace.intent;
    if (intent === "configure" || intent === "optimize" || intent === "config") return void askForConfigProposal(message, workspace, intent === "optimize" ? "optimize" : "configure");
    if (intent === "compare" || intent === "design" || intent === "chat") {
      const modeHint = /\b(design|ui|ux|html|page|component|layout|website)\b/i.test(message) ? "design" : "chat";
      return void runAssistantComparison(modeHint, message, workspace);
    }
    const prefixes = {
      diagnose: "Agent intent: Diagnose. Identify likely causes from bounded router operational metadata, distinguish evidence from inference, and suggest safe next checks.",
      explain: "Agent intent: Explain route. Explain the routing decision, fallback behavior, and relevant health/policy signals in clear terms.",
      onboard: "Agent intent: Onboard. Teach this console and router workflow progressively, using current operational metadata without exposing request bodies or credentials."
    };
    return void sendChat(`${prefixes[intent] || prefixes.diagnose}\n\nUser request: ${message}`, workspace);
  }
  void sendChat(message, workspace);
});

byId("chat-model-options")?.addEventListener("change", (event) => {
  if (state.chatTurns.length || state.chatBusy) return renderChatModelOptions(state.status?.config || {});
  const id = event.target.value;
  if (event.target.checked) {
    if (state.sandboxSelectedModels.size >= 4) {
      event.target.checked = false;
      return notify("The sandbox supports up to four models per comparison.");
    }
    state.sandboxSelectedModels.add(id);
  } else {
    state.sandboxSelectedModels.delete(id);
  }
  activeWorkspace().modelLineup = [];
  persistArenaWorkspaces();
  renderChatModelOptions(state.status?.config || {});
});

byId("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    byId("chat-form").requestSubmit();
  }
});
byId("chat-input").addEventListener("input", (event) => {
  activeWorkspace().draft = event.target.value;
  activeWorkspace().status = event.target.value ? "draft" : activeWorkspace().status === "draft" ? "ready" : activeWorkspace().status;
  persistArenaWorkspaces();
});
byId("chat-messages").addEventListener("click", (event) => {
  const retry = event.target.closest("[data-retry-lane]");
  if (retry) void retrySandboxGeneration(retry.dataset.retryLane, Number(retry.dataset.retryTurn));
  const star = event.target.closest("[data-star-lane]");
  if (star) {
    const result = state.chatTurns[Number(star.dataset.starTurn)]?.results?.[star.dataset.starLane];
    if (!result) return;
    result.starred = !result.starred; star.classList.toggle("active", result.starred); star.textContent = result.starred ? "★" : "☆"; star.setAttribute("aria-pressed", String(result.starred)); star.title = result.starred ? "Remove from starred gallery" : "Add to starred gallery"; void saveSandboxRun();
  }
  const promptAction = event.target.closest("[data-prompt-action]");
  if (promptAction) {
    const prompt = promptAction.closest(".chat-message")?.querySelector(".content")?.textContent || "";
    if (promptAction.dataset.promptAction === "copy-prompt") void copyToClipboard(prompt, "Prompt copied.", "Clipboard access was unavailable. Select the prompt manually.");
    else if (promptAction.dataset.promptAction === "reuse-prompt") { activeWorkspace().draft = prompt; byId("chat-input").value = prompt; byId("chat-input").focus(); persistArenaWorkspaces(); }
  }
  const resultAction = event.target.closest("[data-result-action]");
  if (resultAction) {
    const card = resultAction.closest(".sandbox-result");
    const result = activeWorkspace().turns[Number(card?.dataset.sandboxTurn)]?.results?.[card?.dataset.sandboxLane];
    const content = result?.content || card?.querySelector(":scope > .content")?.innerText || "";
    if (resultAction.dataset.resultAction === "listen") {
      if (!result || result.error || !Number.isInteger(Number(card?.dataset.sandboxTurn))) return setAudioStatus("SPEECH REFUSED / RESULT IS NO LONGER AVAILABLE", true);
      void playResultSpeech(resultAction, result, activeWorkspace().turns[Number(card.dataset.sandboxTurn)].mode || activeWorkspace().mode, resultAction.dataset.ttsKey);
    }
    else if (resultAction.dataset.resultAction === "copy-result") void copyToClipboard(content, "Result copied.", "Clipboard access was unavailable. Select the result manually.");
    else if (resultAction.dataset.resultAction === "focus-result") {
      const focused = card?.classList.toggle("focused-result") ?? false;
      resultAction.setAttribute("aria-pressed", String(focused));
      if (focused) { card.tabIndex = -1; card.focus(); }
    }
  }
});
byId("sandbox-provider-default-max").addEventListener("change", (event) => {
  byId("sandbox-max-tokens").disabled = event.target.checked;
  readGenerationControls(); persistArenaWorkspaces();
});
for (const id of ["sandbox-max-tokens", "sandbox-temperature", "sandbox-top-p"]) byId(id).addEventListener("input", () => { readGenerationControls(); persistArenaWorkspaces(); });

async function newActiveWorkstream(clearModels = false) {
  const workspace = activeWorkspace();
  if (workspace.busy) return notify("Stop this workstream before starting a new one.");
  stopTts();
  try { await saveSandboxRun(workspace); }
  catch (error) { notify(`Autosave failed; the current workstream was preserved: ${error.message}`); return; }
  const replacement = createArenaWorkspace(workspace.mode, {
    selectedModels: clearModels ? [] : [...workspace.selectedModels],
    modelLineup: clearModels ? [] : workspaceModelLanes(workspace).map((lane) => lane.model)
  });
  replacement._defaultsLoaded = !clearModels;
  state.arenaWorkspaces[workspace.mode] = replacement;
  state.sandboxModelSignature = null;
  persistArenaWorkspaces();
  renderActiveWorkspace();
  if (clearModels) byId("chat-model-picker").open = true;
}
byId("clear-chat").addEventListener("click", () => void newActiveWorkstream(false));
byId("new-lineup").addEventListener("click", () => void newActiveWorkstream(true));

byId("stop-chat").addEventListener("click", () => state.chatController?.abort());
byId("propose-config").addEventListener("click", () => {
  const input = byId("chat-input");
  const prompt = input.value.trim();
  activeWorkspace().draft = input.value;
  void askForConfigProposal(prompt, activeWorkspace(), "configure");
});

byId("config-proposal-host").addEventListener("click", async (event) => {
  const workspace = activeWorkspace();
  const action = event.target.closest("[data-proposal-action]")?.dataset.proposalAction;
  if (!action || !workspace.configProposal) return;
  if (action === "discard") {
    workspace.configProposal = null;
    byId("config-proposal-host").replaceChildren();
    persistArenaWorkspaces();
    void saveSandboxRun(workspace);
    return;
  }
  if (action === "validate") {
    const card = event.target.closest(".config-proposal");
    const validation = card.querySelector(".proposal-validation-status");
    try {
      const patch = proposalPatchFromEditor(card);
      const payload = await api("/admin/api/config/proposals/validate", {
        method: "POST",
        body: JSON.stringify({ baseRevision: workspace.configProposal.baseRevision, summary: workspace.configProposal.summary, rationale: workspace.configProposal.rationale, patch })
      });
      renderConfigProposal(payload.proposal, workspace);
      await saveSandboxRun(workspace);
      notify("Edited proposal validated. It remains unapplied.", true);
    } catch (error) {
      validation.className = "proposal-validation-status error"; validation.textContent = error.message;
      notify(error.message);
    }
    return;
  }
  if (event.target.closest(".config-proposal")?.dataset.proposalDirty === "true") {
    return notify("Revalidate the edited patch before review and apply.");
  }
  const list = byId("proposal-confirm-changes");
  list.replaceChildren();
  for (const change of workspace.configProposal.changes) {
    const row = document.createElement("p");
    row.textContent = `${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
    list.append(row);
  }
  state.confirmingProposal = { proposal: structuredClone(workspace.configProposal), workspace };
  byId("proposal-confirm-dialog").showModal();
});

byId("confirm-apply-proposal").addEventListener("click", async (event) => {
  event.preventDefault();
  const confirmation = state.confirmingProposal;
  if (!confirmation) return;
  const { proposal, workspace } = confirmation;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api(`/admin/api/config/proposals/${proposal.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true })
    });
    byId("proposal-confirm-dialog").close();
    state.confirmingProposal = null;
    workspace.configProposal = null;
    if (workspace === activeWorkspace()) byId("config-proposal-host").replaceChildren();
    await saveSandboxRun(workspace);
    notify("Reviewed configuration proposal applied.", true);
    await load(true);
  } catch (error) {
    notify(error.message);
    if (error.status === 409) {
      workspace.configProposal = null;
      if (workspace === activeWorkspace()) byId("config-proposal-host").replaceChildren();
      await saveSandboxRun(workspace).catch(() => {});
      await load(true);
    }
  } finally {
    button.disabled = false;
  }
});
byId("proposal-confirm-dialog").addEventListener("close", () => {
  if (byId("proposal-confirm-dialog").returnValue !== "apply") state.confirmingProposal = null;
});

function setSandboxMode(mode, force = false) {
  mode = "diagnose";
  const previous = activeWorkspace();
  if (previous.mode !== mode) stopTts();
  if (byId("chat-input")) previous.draft = byId("chat-input").value;
  if (byId("sandbox-max-tokens")) readGenerationControls(previous);
  if (byId("chat-messages")) previous.scrollTop = byId("chat-messages").scrollTop;
  state.sandboxMode = mode;
  state.sandboxModelSignature = null;
  for (const button of document.querySelectorAll("[data-sandbox-mode]")) {
    const active = button.dataset.sandboxMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  byId("propose-config").hidden = mode !== "diagnose" || !["configure", "optimize"].includes(activeWorkspace().intent);
  byId("chat-input").placeholder = mode === "design"
    ? "Describe a responsive page or component to generate..."
    : mode === "diagnose"
      ? "Ask for diagnosis, configuration suggestions, or help using RouteTok..."
      : "Send one prompt to every selected model...";
  byId("send-chat").textContent = mode === "design" ? "GENERATE" : "SEND";
  persistArenaWorkspaces();
  if (!state.sandboxLibraryOpen || force) renderActiveWorkspace();
}

byId("sandbox-mode").addEventListener("click", (event) => {
  const button = event.target.closest("[data-sandbox-mode]");
  if (button) setSandboxMode(button.dataset.sandboxMode);
});
byId("agent-intents").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-agent-intent]");
  if (!chip) return;
  activeWorkspace().intent = chip.dataset.agentIntent;
  persistArenaWorkspaces();
  renderArenaStatus();
  const framing = { diagnose: "Describe symptoms or unexpected router behavior...", explain: "Ask why a request took a route or fallback...", onboard: "Ask how to use or understand RouteTok...", optimize: "Describe the reliability, latency, or cost objective...", configure: "Describe the policy change to propose...", compare: "Describe a comparison to plan; it will not run automatically..." };
  byId("chat-input").placeholder = chip.dataset.agentIntent === "auto" ? "Ask naturally; Agent will choose the appropriate safe workflow..." : framing[chip.dataset.agentIntent];
});

byId("audio-record").addEventListener("click", () => void startRecording());
byId("audio-file-button").addEventListener("click", () => byId("audio-file").click());
byId("audio-file").addEventListener("click", () => { audioState.fileTarget = captureTranscriptTarget(); });
byId("audio-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if ((file.type && !file.type.startsWith("audio/")) || !["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"].includes(extension || "")) return setAudioStatus("FILE REJECTED / SELECT SUPPORTED AUDIO", true);
  if (file.size > AUDIO_MAX_BYTES) return setAudioStatus("FILE REJECTED / 16 MiB MAXIMUM", true);
  stopRecorder(false, "RECORDING DISCARDED / FILE SELECTED");
  void transcribeAudio(file, audioState.fileTarget || captureTranscriptTarget());
  audioState.fileTarget = null;
});
for (const [id, key] of [["audio-stt-model", "sttModel"], ["audio-language", "language"], ["audio-tts-model", "ttsModel"], ["audio-voice", "voice"], ["audio-speed", "speed"]]) {
  byId(id).addEventListener("change", (event) => {
    audioState.settings[key] = key === "speed" ? Math.max(0.25, Math.min(4, Number(event.target.value) || 1)) : event.target.value;
    if (["ttsModel", "voice", "speed"].includes(key)) stopTts();
    if (key === "ttsModel") syncAudioControls();
    else persistAudioSettings();
  });
}
byId("discard-transcript").addEventListener("click", () => byId("transcript-review-dialog").close("discard"));
byId("insert-transcript").addEventListener("click", () => {
  const target = audioState.transcriptTarget;
  const workspace = target && state.arenaWorkspaces[target.mode];
  if (!target || !workspace || workspace.runId !== target.runId) {
    setAudioStatus("INSERT REFUSED / ORIGINAL WORKSTREAM CHANGED", true);
    byId("transcript-review-dialog").close("stale");
    return;
  }
  const transcript = byId("transcript-review-text").value;
  const draftChanged = workspace.draft !== target.draft;
  const activeInput = activeWorkspace() === workspace ? byId("chat-input") : null;
  const start = draftChanged ? (activeInput?.selectionStart ?? workspace.draft.length) : Math.min(target.start, workspace.draft.length);
  const end = draftChanged ? (activeInput?.selectionEnd ?? start) : Math.max(start, Math.min(target.end, workspace.draft.length));
  workspace.draft = `${workspace.draft.slice(0, start)}${transcript}${workspace.draft.slice(end)}`;
  workspace.status = workspace.draft ? "draft" : workspace.status;
  if (activeWorkspace() === workspace) {
    byId("chat-input").value = workspace.draft;
    const caret = start + transcript.length;
    byId("chat-input").setSelectionRange(caret, caret);
    byId("chat-input").focus();
  }
  persistArenaWorkspaces();
  setAudioStatus(draftChanged ? "TRANSCRIPT INSERTED AT CURRENT CARET / DRAFT CHANGED" : "TRANSCRIPT INSERTED / NOT SENT");
  byId("transcript-review-dialog").close("insert");
});
byId("transcript-review-dialog").addEventListener("close", () => {
  byId("transcript-review-text").value = "";
  audioState.transcriptTarget = null;
});

byId("open-sandbox-library").addEventListener("click", () => { state.sandboxLibraryStarredOnly = false; void setSandboxLibraryOpen(true); });
byId("open-starred-gallery").addEventListener("click", () => { state.sandboxLibraryStarredOnly = true; void setSandboxLibraryOpen(true); });
byId("close-sandbox-library").addEventListener("click", () => void setSandboxLibraryOpen(false));
byId("sandbox-library-list").addEventListener("click", async (event) => {
  const open = event.target.closest("[data-run-id]")?.dataset.runId;
  if (open) return openSavedRun(open);
  const remove = event.target.closest("[data-delete-run]")?.dataset.deleteRun;
  if (!remove || !confirm("Delete this saved run and its archived content?")) return;
  try {
    await sandboxStore("readwrite", (store) => store.delete(remove));
    await renderSandboxLibrary();
  } catch (error) {
    notify(`Saved run could not be deleted: ${error.message}`);
  }
});
byId("open-assistant").addEventListener("click", () => {
  setSandboxMode("diagnose", true);
  setChatOpen(true);
});
for (const id of ["open-help", "sandbox-help"]) byId(id)?.addEventListener("click", () => byId("help-dialog").showModal());

async function loadClientKeys() {
  const list = byId("client-key-list");
  list.replaceChildren();
  const loading = document.createElement("p"); loading.className = "muted"; loading.textContent = "Loading managed client keys…"; list.append(loading);
  try {
    const payload = await api("/admin/api/client-keys");
    list.replaceChildren();
    byId("client-key-environment").textContent = payload.environmentKeyConfigured ? "Environment PROXY_API_KEY: configured and still accepted" : "Environment PROXY_API_KEY: not configured";
    for (const key of payload.keys || []) {
      const row = document.createElement("article"); row.className = "client-key-row";
      const identity = document.createElement("div"); const title = document.createElement("strong"); const created = document.createElement("small");
      title.textContent = key.label; created.textContent = `Created ${new Date(key.createdAt).toLocaleString()} · ${key.id}`; identity.append(title, created);
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "button danger"; revoke.textContent = "REVOKE"; revoke.dataset.revokeClientKey = key.id; revoke.dataset.clientKeyLabel = key.label;
      row.append(identity, revoke); list.append(row);
    }
    if (!payload.keys?.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No managed client keys. Existing environment authentication is unchanged."; list.append(empty); }
  } catch (error) {
    loading.textContent = error.message;
  }
}

byId("create-client-key").addEventListener("submit", async (event) => {
  event.preventDefault(); const label = byId("client-key-label").value.trim(); const button = event.submitter;
  if (!label) return;
  button.disabled = true;
  try {
    const payload = await api("/admin/api/client-keys", { method: "POST", body: JSON.stringify({ label }) });
    state.clientKeySecret = payload.secret; byId("client-key-secret-value").textContent = payload.secret; byId("client-key-secret").hidden = false; byId("client-key-label").value = "";
    await loadClientKeys(); byId("copy-client-key").focus(); notify("Client API key created. Copy it now; it will not be shown again.", true);
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
byId("client-key-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-client-key]"); if (!button) return;
  if (!confirm(`Revoke client key “${button.dataset.clientKeyLabel}”? Applications using it will immediately lose access.`)) return;
  button.disabled = true;
  try { await api(`/admin/api/client-keys/${encodeURIComponent(button.dataset.revokeClientKey)}`, { method: "DELETE" }); await loadClientKeys(); notify("Client API key revoked.", true); }
  catch (error) { notify(error.message); button.disabled = false; }
});
byId("copy-client-key").addEventListener("click", async () => {
  await copyToClipboard(state.clientKeySecret || "", "Client API key copied.", "Clipboard access was unavailable. Select the key manually.");
});
byId("dismiss-client-key").addEventListener("click", () => { state.clientKeySecret = ""; byId("client-key-secret-value").textContent = ""; byId("client-key-secret").hidden = true; });

byId("open-api-keys").addEventListener("click", () => {
  renderApiKeyManager();
  byId("api-keys-dialog").showModal();
});
byId("manage-api-keys").addEventListener("click", () => byId("open-api-keys").click());
const apiBaseUrl = `${location.origin}/v1`;
const apiCurlExample = `curl ${apiBaseUrl}/chat/completions \\\n+  -H "Authorization: Bearer $ROUTETOK_PROXY_KEY" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"model":"best","messages":[{"role":"user","content":"Hello"}]}'`;
byId("api-base-url").textContent = apiBaseUrl;
const normalizedApiCurlExample = apiCurlExample.replaceAll("\n+  ", "\n  ");
byId("api-curl-example").textContent = normalizedApiCurlExample;
document.querySelectorAll("[data-copy-api]").forEach((button) => button.addEventListener("click", async () => {
  await copyToClipboard(normalizedApiCurlExample, "API example copied.", "Clipboard access was unavailable. Select the example manually.");
}));
byId("api-key-manager").addEventListener("click", async (event) => {
  const target = event.target.closest("[data-credential-update], [data-credential-delete]");
  if (!target) return;
  const descriptor = target.dataset.credentialUpdate || target.dataset.credentialDelete;
  const [providerId, field] = descriptor.split(":");
  const path = `/admin/api/providers/${encodeURIComponent(providerId)}/credentials/${encodeURIComponent(field)}`;
  target.disabled = true;
  try {
    if (target.dataset.credentialUpdate) {
      const input = byId("api-key-manager").querySelector(`[data-credential-input="${CSS.escape(descriptor)}"]`);
      const value = input.value;
      input.value = "";
      if (!value.trim()) throw new Error("Enter a key before updating.");
      await api(path, { method: "PUT", body: JSON.stringify({ value }) });
    } else {
      if (!confirm(`Delete the stored ${providerId} ${field}? Environment credentials will remain suppressed until replaced.`)) return;
      await api(path, { method: "DELETE" });
    }
    await load(true);
    renderApiKeyManager();
    notify(target.dataset.credentialUpdate ? `${providerId} ${field} credential updated.` : `${providerId} ${field} stored credential deleted.`, true);
  } catch (error) {
    notify(error.message);
  } finally {
    target.disabled = false;
  }
});

byId("export-chat").addEventListener("click", () => {
  if (!state.chatTurns.length) return notify("Run a comparison before exporting it.");
  const payload = { version: 2, exportedAt: new Date().toISOString(), modelLineup: workspaceModelLanes().map((lane) => lane.model), turns: state.chatTurns };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `model-sandbox-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

byId("toggle-chat").addEventListener("click", () => {
  setChatOpen(false);
});

byId("open-chat").addEventListener("click", () => {
  setSandboxMode("diagnose", true);
  setChatOpen(true);
});

byId("chat-messages").addEventListener("scroll", () => {
  const container = byId("chat-messages");
  activeWorkspace().scrollTop = container.scrollTop;
  activeWorkspace().userScrolled = !isUserNearBottom(container);
  window.clearTimeout(state.arenaScrollTimer);
  state.arenaScrollTimer = window.setTimeout(persistArenaWorkspaces, 150);
});

const resizeHandle = byId("chat-resize-handle");
const chatDrawer = byId("chat-drawer");
let resizing = false;
let startY, startHeight;

resizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  resizing = true;
  startY = e.clientY;
  startHeight = chatDrawer.offsetHeight;
  document.body.style.cursor = "ns-resize";
  document.body.style.userSelect = "none";
});

document.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const delta = startY - e.clientY;
  const newHeight = Math.max(200, Math.min(window.innerHeight - 60, startHeight + delta));
  chatDrawer.style.height = `${newHeight}px`;
  resizeHandle.setAttribute("aria-valuenow", String(Math.round(newHeight)));
});
resizeHandle.setAttribute("aria-valuenow", String(Math.round(chatDrawer.offsetHeight)));
resizeHandle.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const maximum = Math.max(240, window.innerHeight - 24);
  const height = event.key === "Home" ? 240 : event.key === "End" ? maximum : Math.max(240, Math.min(maximum, chatDrawer.offsetHeight + (event.key === "ArrowUp" ? 24 : -24)));
  chatDrawer.style.height = `${height}px`;
  resizeHandle.setAttribute("aria-valuemax", String(Math.round(maximum)));
  resizeHandle.setAttribute("aria-valuenow", String(Math.round(height)));
});

document.addEventListener("mouseup", () => {
  if (!resizing) return;
  resizing = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

function toggleFocusMode() {
  const enabled = document.documentElement.classList.toggle("focus-mode");
  for (const target of document.querySelectorAll(".live-panel, .history-panel")) {
    target.classList.toggle("focus-mode-target", enabled);
  }
  sessionStorage.setItem(FOCUS_MODE_KEY, String(enabled));
  notify(`Focus mode ${enabled ? "enabled" : "disabled"}.`, true);
}

function jumpTo(selector) {
  const target = document.querySelector(selector);
  if (!target) return;
  target.scrollIntoView({ behavior: document.documentElement.dataset.motion === "reduced" ? "auto" : "smooth", block: "start" });
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

function cycleTheme() {
  const themes = ["router", "abyss", "ultraviolet", "ember", "paper", "system"];
  updatePreference("theme", themes[(themes.indexOf(state.preferences.theme) + 1) % themes.length]);
}

const COMMANDS = [
  { label: "Open Support", keywords: "assistant diagnose help", run: () => setChatOpen(true) },
  { label: "Open routing config", keywords: "policy settings", run: () => setConfigOpen(true) },
  { label: "Open model manager", keywords: "catalog providers quality order", run: () => { setConfigOpen(true); byId("model-manager")?.scrollIntoView({ block: "start" }); byId("model-search")?.focus(); } },
  { label: "Customize dashboard", keywords: "preferences appearance", run: () => setCustomizeOpen(true) },
  { label: "Refresh dashboard", keywords: "reload telemetry history", run: () => void refreshDashboard() },
  { label: "Toggle focus mode", keywords: "zen", run: toggleFocusMode },
  { label: "Mark baseline", keywords: "compare surprise", run: markBaseline },
  { label: "Clear baseline", keywords: "reset comparison", run: () => clearBaseline() },
  { label: "Cycle theme", keywords: "router paper system", run: cycleTheme },
  { label: "Toggle in-flight rail", keywords: "live flow expand collapse", run: () => setRailExpanded(!state.railExpanded) },
  { label: "Move in-flight display left", keywords: "live flow side", run: () => updatePreference("inflightPlacement", "left") },
  { label: "Move in-flight display right", keywords: "live flow side", run: () => updatePreference("inflightPlacement", "right") },
  { label: "Move in-flight display to main column", keywords: "live flow layout", run: () => updatePreference("inflightPlacement", "main") },
  { label: "Collapse all dashboard sections", keywords: "layout panels", run: () => byId("collapse-all-sections")?.click() },
  { label: "Expand all dashboard sections", keywords: "layout panels", run: () => byId("expand-all-sections")?.click() },
  { label: "Open Live Flow", keywords: "in flight requests", run: () => setRailExpanded(true) },
  { label: "Jump to History", keywords: "signal performance trends", run: () => jumpTo("#history, .history-panel") },
  { label: "Jump to Model Fabric", keywords: "route health catalog", run: () => jumpTo("#model-fabric, .health-panel") },
  { label: "Jump to Request Log", keywords: "recent decisions", run: () => jumpTo("#request-log, .recent-panel") }
];

function filteredCommands() {
  const query = (byId("command-input")?.value || "").trim().toLowerCase();
  return COMMANDS.filter((command) => `${command.label} ${command.keywords}`.toLowerCase().includes(query));
}

function renderCommands() {
  const list = firstById("command-results", "command-list");
  if (!list) return;
  list.setAttribute("role", "listbox");
  const commands = filteredCommands();
  state.commandIndex = Math.max(0, Math.min(state.commandIndex, commands.length - 1));
  list.replaceChildren();
  if (!commands.length) {
    const empty = document.createElement("p");
    empty.textContent = "NO MATCHING COMMANDS";
    empty.className = "command-empty";
    list.append(empty);
    byId("command-input")?.removeAttribute("aria-activedescendant");
    return;
  }
  commands.forEach((command, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "command-result command-item";
    item.id = `command-option-${index}`;
    item.textContent = command.label;
    item.dataset.commandIndex = String(index);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === state.commandIndex));
    item.tabIndex = -1;
    item.addEventListener("click", () => runCommand(index));
    list.append(item);
  });
  byId("command-input")?.setAttribute("aria-activedescendant", `command-option-${state.commandIndex}`);
  list.querySelector("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
}

function setCommandOpen(open) {
  const palette = byId("command-palette");
  if (!palette) return;
  if (open === state.commandOpen) return;
  state.commandOpen = open;
  if (open) {
    state.commandReturnFocus = document.activeElement;
    state.commandIndex = 0;
    if (palette instanceof HTMLDialogElement) palette.showModal();
    else {
      palette.hidden = false;
      palette.classList.add("open");
      palette.setAttribute("aria-hidden", "false");
    }
    const input = byId("command-input");
    if (input) input.value = "";
    input?.setAttribute("aria-expanded", "true");
    renderCommands();
    input?.focus();
  } else {
    if (palette instanceof HTMLDialogElement && palette.open) palette.close();
    else {
      palette.hidden = true;
      palette.classList.remove("open");
      palette.setAttribute("aria-hidden", "true");
    }
    if (state.commandReturnFocus?.isConnected) state.commandReturnFocus.focus();
    state.commandReturnFocus = null;
    byId("command-input")?.setAttribute("aria-expanded", "false");
    byId("command-input")?.removeAttribute("aria-activedescendant");
  }
  byId("open-command")?.setAttribute("aria-expanded", String(open));
}

function runCommand(index) {
  const command = filteredCommands()[index];
  if (!command) return;
  setCommandOpen(false);
  command.run();
}

byId("open-command")?.addEventListener("click", () => setCommandOpen(true));
byId("refresh-status")?.addEventListener("click", () => void refreshDashboard());
byId("close-command")?.addEventListener("click", () => setCommandOpen(false));
byId("command-palette")?.addEventListener("cancel", (event) => {
  event.preventDefault();
  setCommandOpen(false);
});
byId("command-input")?.addEventListener("input", () => {
  state.commandIndex = 0;
  renderCommands();
});
byId("command-input")?.addEventListener("keydown", (event) => {
  const commands = filteredCommands();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.commandIndex = commands.length ? (state.commandIndex + direction + commands.length) % commands.length : 0;
    renderCommands();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runCommand(state.commandIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    setCommandOpen(false);
  }
});

byId("set-baseline")?.addEventListener("click", markBaseline);
byId("clear-baseline")?.addEventListener("click", () => clearBaseline());

function isTyping() {
  const active = document.activeElement;
  return Boolean(active?.matches("input, textarea, select, [contenteditable='true']"));
}

document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    setCommandOpen(!state.commandOpen);
    return;
  }
  if (event.key === "Tab" && (state.customizeOpen || state.apiAccessOpen || state.configOpen)) {
    const container = byId(state.apiAccessOpen ? "api-access" : state.customizeOpen ? "customize-drawer" : "config-drawer");
    const focusable = focusableElements(container);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!focusable.includes(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key === "Escape") {
    const focusedResult = document.querySelector(".sandbox-result.focused-result");
    if (focusedResult) {
      focusedResult.classList.remove("focused-result");
      focusedResult.querySelector('[data-result-action="focus-result"]')?.setAttribute("aria-pressed", "false");
    } else if (state.commandOpen) setCommandOpen(false);
    else if (state.apiAccessOpen) setApiAccessOpen(false);
    else if (state.customizeOpen) setCustomizeOpen(false);
    else if (state.configOpen) setConfigOpen(false);
    else if (state.chatOpen) setChatOpen(false);
    return;
  }
  if (isTyping()) return;
  if (event.key.toLowerCase() === "b" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    if (event.shiftKey) clearBaseline();
    else markBaseline();
  } else if (event.key.toLowerCase() === "u") {
    event.preventDefault();
    void refreshDashboard();
  }
});

window.addEventListener("storage", (event) => {
  if (event.key === PREFERENCES_KEY) applyPreferences(event.newValue ? readStoredJson(localStorage, PREFERENCES_KEY) : PREFERENCE_DEFAULTS);
});
themeMedia.addEventListener("change", () => {
  if (state.preferences.theme === "system") applyPreferences(state.preferences);
});
motionMedia.addEventListener("change", () => {
  if (state.preferences.motion === "system") applyPreferences(state.preferences);
});
document.addEventListener("routetok:preferenceschange", () => {
  if (state.status && byId("history-range")) {
    renderHistory();
    renderHealth(state.status.catalog, state.status.metrics, state.status.config);
  }
});

if (document.documentElement.classList.contains("focus-mode")) {
  for (const target of document.querySelectorAll(".live-panel, .history-panel")) target.classList.add("focus-mode-target");
}

const savedHistoryRange = localStorage.getItem("routetok-history-range") || localStorage.getItem("agentrouter-history-range");
if (["100", "500", "2000", "5000"].includes(savedHistoryRange)) {
  byId("history-range").value = savedHistoryRange;
}
byId("history-range").addEventListener("change", () => {
  localStorage.setItem("routetok-history-range", byId("history-range").value);
  renderHistory();
});

await restoreArenaWorkspaces();
byId("chat-input").value = activeWorkspace().draft;
applyGenerationControls(activeWorkspace());
setConnectionState(document.visibilityState === "visible" ? "offline" : "paused");
setupCollapsibleSections();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopRecorder(false, "RECORDING DISCARDED / PAGE HIDDEN");
    audioState.sttController?.abort();
    stopTts();
    setConnectionState("paused");
    return;
  }
  updateStaleness();
  void load(false);
  void loadLive();
});
window.addEventListener("pagehide", () => {
  stopRecorder(false, "RECORDING DISCARDED / PAGE CLOSED");
  audioState.sttController?.abort();
  stopTts();
  stopMediaTracks();
});
state.staleTimer = window.setInterval(updateStaleness, 1_000);

await load();
const arenaQuery = new URLSearchParams(location.search);
const queryMode = arenaQuery.get("mode");
const queryRun = arenaQuery.get("run");
if (queryRun) {
  await openSavedRun(queryRun).catch((error) => notify(`Could not restore saved run: ${error.message}`));
} else if (queryMode === "diagnose") {
  setSandboxMode(queryMode, true);
} else {
  setSandboxMode(state.sandboxMode, true);
}
function scheduleRefresh() {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(async () => {
    if (document.visibilityState === "visible") await load(true);
    scheduleRefresh();
  }, state.liveUpdatesAvailable ? 5_000 : 1_000);
}
function scheduleLiveRefresh() {
  window.clearTimeout(state.liveTimer);
  state.liveTimer = window.setTimeout(async () => {
    await loadLive();
    scheduleLiveRefresh();
  }, 500);
}
scheduleRefresh();
scheduleLiveRefresh();
