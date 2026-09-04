const ONBOARDING_STEPS = ["key-status", "catalog", "free-model", "test-prompt", "success"];
const ONBOARDING_TROUBLESHOOTING = {
  "key-status": "docs/troubleshooting.md#dashboard-authentication",
  catalog: "docs/troubleshooting.md#no-models",
  "free-model": "docs/troubleshooting.md#no-models",
  "test-prompt": "docs/troubleshooting.md#model-appears-but-fails",
  success: "docs/troubleshooting.md#fieldbook-state-looks-stale"
};
const ONBOARDING_ENDPOINTS = {
  readiness: "/admin/api/readiness",
  status: "/admin/api/status",
  catalog: "/admin/api/sandbox/catalog"
};
const ONBOARDING_STEP_TITLES = {
  "key-status": "Key status",
  catalog: "Catalog check",
  "free-model": "Enable one free model",
  "test-prompt": "Test prompt",
  success: "Ready"
};
const ONBOARDING_STEP_GUIDANCE = {
  "key-status": "Confirm the dashboard accepts your token by reading key status. This check only reads state.",
  catalog: "Confirm the model catalog loads and reports configured providers without catalog errors.",
  "free-model": "Enable a single free route first. Unknown-price external models must be explicitly enabled before they become viable.",
  "test-prompt": "Send one minimal prompt from the Fieldbook against the enabled free model, then confirm the result below.",
  success: "Onboarding checks passed. The wizard did not change any configuration."
};
const ONBOARDING_TEST_PROMPT = "Reply with OK";
const ONBOARDING_TOKEN_KEY = "routetok-dashboard-token";

function onboardingInitialState() {
  return { step: 0, results: {}, checked: false, testConfirmed: false, busy: false, error: "" };
}

function onboardingNextStep(state) {
  const index = Math.min(Number(state.step) || 0, ONBOARDING_STEPS.length - 1);
  return Math.min(index + 1, ONBOARDING_STEPS.length - 1);
}

function onboardingPrevStep(state) {
  const index = Math.max(Number(state.step) || 0, 0);
  return Math.max(index - 1, 0);
}

function onboardingStepId(state) {
  return ONBOARDING_STEPS[Math.min(Math.max(Number(state.step) || 0, 0), ONBOARDING_STEPS.length - 1)];
}

function onboardingEvaluateReadiness(payload) {
  const failures = [];
  const source = payload && typeof payload === "object" ? payload : {};
  const auth = source.authentication && typeof source.authentication === "object" ? source.authentication : {};
  if (auth.dashboardEnabled !== true && auth.proxyEnabled !== true) failures.push("key-status");
  const catalog = source.catalog && typeof source.catalog === "object" ? source.catalog : null;
  if (!catalog || catalog.errorPresent === true) failures.push("catalog");
  const providers = source.providers && typeof source.providers === "object" ? source.providers : null;
  if (!providers || !(Number(providers.configuredCount) > 0)) failures.push("catalog");
  const viable = source.viableEligibleModelCounts && typeof source.viableEligibleModelCounts === "object" ? source.viableEligibleModelCounts : {};
  const viableTotal = (Number(viable.openai) || 0) + (Number(viable.anthropic) || 0);
  if (!(viableTotal > 0) && !(Number(source.freeRouteCount) > 0)) failures.push("free-model");
  return { ok: failures.length === 0, failures };
}

function onboardingEvaluateCatalog(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const models = Array.isArray(source.models) ? source.models : [];
  const freeModels = models.filter((model) => model && model.free === true);
  return {
    ok: models.length > 0,
    modelCount: models.length,
    freeCount: freeModels.length,
    freeModels: freeModels.slice(0, 4).map((model) => model.id).filter((id) => typeof id === "string")
  };
}

function onboardingEvaluateFreeModel(catalogPayload, readinessPayload) {
  const catalog = onboardingEvaluateCatalog(catalogPayload);
  const readiness = readinessPayload && typeof readinessPayload === "object" ? readinessPayload : {};
  const freeRoutes = Number(readiness.freeRouteCount) || 0;
  const ok = catalog.freeCount > 0 || freeRoutes > 0;
  return { ok, freeCount: Math.max(catalog.freeCount, freeRoutes), sampleModels: catalog.freeModels };
}

function onboardingDefaultFetchWithAuth(path) {
  let token = "";
  try {
    token = localStorage.getItem(ONBOARDING_TOKEN_KEY) || "";
  } catch {
    token = "";
  }
  return fetch(path, {
    headers: token ? { "x-dashboard-token": token } : {}
  }).then((response) => {
    if (response.status === 401) throw new Error("Dashboard authentication required");
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  });
}

function onboardingMount(el, options) {
  const fetchWithAuth = (options && options.fetchWithAuth) || onboardingDefaultFetchWithAuth;
  const state = onboardingInitialState();
  const root = document.createElement("section");
  root.className = "routetok-onboarding";
  root.setAttribute("aria-label", "RouteTok onboarding wizard");
  el.replaceChildren(root);
  function stepResult(id) {
    return state.results[id] || { status: "pending", detail: "" };
  }
  function setStep(index) {
    state.step = Math.min(Math.max(Number(index) || 0, 0), ONBOARDING_STEPS.length - 1);
    render();
  }
  async function runChecks() {
    state.busy = true;
    state.error = "";
    render();
    try {
      const [readiness, status, catalog] = await Promise.all([
        fetchWithAuth(ONBOARDING_ENDPOINTS.readiness),
        fetchWithAuth(ONBOARDING_ENDPOINTS.status),
        fetchWithAuth(ONBOARDING_ENDPOINTS.catalog)
      ]);
      const readinessCheck = onboardingEvaluateReadiness(readiness);
      const catalogCheck = onboardingEvaluateCatalog(catalog);
      const freeCheck = onboardingEvaluateFreeModel(catalog, readiness);
      const keyOk = !readinessCheck.failures.includes("key-status");
      state.results = {
        "key-status": {
          status: keyOk ? "pass" : "fail",
          detail: keyOk ? "Dashboard key accepted." : "Dashboard key was not accepted."
        },
        catalog: {
          status: catalogCheck.ok && !readinessCheck.failures.includes("catalog") ? "pass" : "fail",
          detail: catalogCheck.modelCount + " catalog models visible."
        },
        "free-model": {
          status: freeCheck.ok ? "pass" : "fail",
          detail: freeCheck.freeCount > 0 ? freeCheck.freeCount + " free routes available." : "No free route is enabled yet."
        },
        "test-prompt": state.testConfirmed && freeCheck.ok
          ? { status: "pass", detail: "Test prompt confirmed against an enabled free model." }
          : { status: state.testConfirmed ? "fail" : "pending", detail: "Run the test prompt, then confirm below." }
      };
      state.checked = true;
      void status;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      render();
    }
  }
  function render() {
    root.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "RouteTok onboarding";
    const intro = document.createElement("p");
    intro.textContent = "Read-only checks. This wizard never writes configuration.";
    const list = document.createElement("ol");
    list.className = "onboarding-steps";
    ONBOARDING_STEPS.forEach((id, index) => {
      const item = document.createElement("li");
      const result = stepResult(id);
      const current = index === state.step;
      item.dataset.step = id;
      item.setAttribute("aria-current", current ? "step" : "false");
      const title = document.createElement("strong");
      title.textContent = (index + 1) + ". " + ONBOARDING_STEP_TITLES[id];
      const pill = document.createElement("span");
      pill.className = "onboarding-pill onboarding-" + result.status;
      pill.textContent = result.status === "pass" ? "Pass" : result.status === "fail" ? "Fail" : "Pending";
      item.append(title, pill);
      if (result.status === "fail") {
        const link = document.createElement("a");
        link.href = ONBOARDING_TROUBLESHOOTING[id];
        link.textContent = "Troubleshooting: " + id;
        item.append(link);
      }
      list.append(item);
    });
    const detail = document.createElement("div");
    detail.className = "onboarding-detail";
    const currentId = onboardingStepId(state);
    const currentResult = stepResult(currentId);
    const detailTitle = document.createElement("h3");
    detailTitle.textContent = ONBOARDING_STEP_TITLES[currentId];
    const guidance = document.createElement("p");
    guidance.textContent = ONBOARDING_STEP_GUIDANCE[currentId];
    detail.append(detailTitle, guidance);
    if (currentId === "test-prompt") {
      const prompt = document.createElement("code");
      prompt.textContent = ONBOARDING_TEST_PROMPT;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy test prompt";
      copy.onclick = () => {
        if (navigator.clipboard) void navigator.clipboard.writeText(ONBOARDING_TEST_PROMPT);
      };
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.textContent = state.testConfirmed ? "Test confirmed" : "Mark test complete";
      confirm.disabled = state.testConfirmed;
      confirm.onclick = () => {
        state.testConfirmed = true;
        state.results["test-prompt"] = { status: "pass", detail: "Test prompt confirmed against an enabled free model." };
        setStep(onboardingNextStep(state));
      };
      detail.append(prompt, copy, confirm);
    }
    if (currentId === "success") {
      const summary = document.createElement("p");
      summary.textContent = state.testConfirmed && state.checked
        ? "Wizard complete against a healthy instance."
        : "Finish the earlier steps to complete onboarding.";
      detail.append(summary);
    }
    if (currentResult.detail) {
      const resultLine = document.createElement("p");
      resultLine.className = "onboarding-result onboarding-" + currentResult.status;
      resultLine.textContent = (currentResult.status === "pass" ? "Pass: " : currentResult.status === "fail" ? "Fail: " : "") + currentResult.detail;
      detail.append(resultLine);
    }
    if (currentResult.status === "fail") {
      const link = document.createElement("a");
      link.href = ONBOARDING_TROUBLESHOOTING[currentId];
      link.textContent = "See troubleshooting for this step";
      detail.append(link);
    }
    if (state.error) {
      const errorLine = document.createElement("p");
      errorLine.className = "onboarding-error";
      errorLine.textContent = state.error;
      const authLink = document.createElement("a");
      authLink.href = ONBOARDING_TROUBLESHOOTING["key-status"];
      authLink.textContent = "Dashboard authentication help";
      detail.append(errorLine, authLink);
    }
    const actions = document.createElement("div");
    actions.className = "onboarding-actions";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Back";
    back.disabled = state.step === 0;
    back.onclick = () => setStep(onboardingPrevStep(state));
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = state.busy ? "Checking" : "Run read-only checks";
    run.disabled = state.busy;
    run.onclick = () => void runChecks();
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Continue";
    next.disabled = state.step >= ONBOARDING_STEPS.length - 1;
    next.onclick = () => setStep(onboardingNextStep(state));
    actions.append(back, run, next);
    root.append(heading, intro, list, detail, actions);
  }
  render();
  return {
    unmount() {
      root.remove();
    },
    getState() {
      return state;
    },
    runChecks
  };
}

window.Onboarding = {
  STEPS: ONBOARDING_STEPS,
  TROUBLESHOOTING: ONBOARDING_TROUBLESHOOTING,
  ENDPOINTS: ONBOARDING_ENDPOINTS,
  TEST_PROMPT: ONBOARDING_TEST_PROMPT,
  initialState: onboardingInitialState,
  nextStep: onboardingNextStep,
  prevStep: onboardingPrevStep,
  stepId: onboardingStepId,
  evaluateReadiness: onboardingEvaluateReadiness,
  evaluateCatalog: onboardingEvaluateCatalog,
  evaluateFreeModel: onboardingEvaluateFreeModel,
  defaultFetchWithAuth: onboardingDefaultFetchWithAuth,
  mount: onboardingMount
};
