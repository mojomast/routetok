const STORAGE_KEY = "routetok-fieldbook-panel-preferences-v1";

export function createPanelManager({ document, storage, panels, onPopout, onChange = () => {} }) {
  const saved = readPreferences(storage);
  const records = new Map();
  const openDrawers = new Map();
  const drawerOrder = [];

  const rail = document.createElement("nav");
  rail.className = "panel-utility-rail";
  rail.setAttribute("aria-label", "Minimized panels");
  const drawerHost = document.createElement("section");
  drawerHost.className = "managed-panel-drawers";
  drawerHost.setAttribute("aria-label", "Open panel drawers");
  drawerHost.hidden = true;
  document.body.append(rail, drawerHost);

  for (const definition of panels) {
    const element = document.getElementById(definition.elementId);
    if (!element) continue;
    const anchor = document.createComment(`panel:${definition.id}`);
    element.before(anchor);
    const preference = saved[definition.id] === "minimized" ? "minimized" : "column";
    records.set(definition.id, { ...definition, element, anchor, preference });
    bindControls(element, definition.id, definition.label);
  }

  function bindControls(element, id, label) {
    element.querySelectorAll("[data-panel-action]").forEach((button) => {
      const action = button.dataset.panelAction;
      if (action === "drawer") button.setAttribute("aria-label", `Open ${label} drawer`);
      else if (action === "column") button.setAttribute("aria-label", `Pin ${label} as a column`);
      else if (action === "minimize") button.setAttribute("aria-label", `Minimize ${label}`);
      else if (action === "popout") button.setAttribute("aria-label", `Pop out ${label} snapshot`);
      button.addEventListener("click", () => {
        if (action === "drawer") openDrawer(id, button);
        else if (action === "column") setPreference(id, "column", button);
        else if (action === "minimize") setPreference(id, "minimized", button);
        else if (action === "popout") onPopout?.(id);
      });
      if (action !== "popout") button.setAttribute("aria-pressed", "false");
    });
  }

  function persist() {
    const value = {};
    records.forEach((record, id) => { value[id] = record.preference; });
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function returnToAnchor(record) {
    record.anchor.parentNode?.insertBefore(record.element, record.anchor.nextSibling);
  }

  function removeDrawer(id) {
    const state = openDrawers.get(id);
    const record = records.get(id);
    if (!state || !record) return null;
    returnToAnchor(record);
    state.card.remove();
    openDrawers.delete(id);
    const orderIndex = drawerOrder.indexOf(id);
    if (orderIndex >= 0) drawerOrder.splice(orderIndex, 1);
    drawerHost.hidden = openDrawers.size === 0;
    document.body.classList.toggle("panel-drawers-open", openDrawers.size > 0);
    return state;
  }

  function closeDrawer(id = drawerOrder.at(-1), { focus = true } = {}) {
    if (!id) return false;
    const record = records.get(id);
    const state = removeDrawer(id);
    if (!record || !state) return false;
    render();
    onChange(id, record.preference);
    if (focus) {
      const utility = rail.querySelector(`[data-panel-utility="${id}"]`);
      const target = record.preference === "minimized" ? utility : state.restoreFocus;
      if (target?.isConnected) target.focus();
    }
    return true;
  }

  function openDrawer(id, trigger = document.activeElement) {
    const record = records.get(id);
    if (!record || record.available?.() === false) return;
    const existing = openDrawers.get(id);
    if (existing) { existing.close.focus(); return; }

    const card = document.createElement("section");
    card.className = "managed-panel-drawer";
    card.setAttribute("role", "dialog");
    const titleId = `panel-drawer-title-${id}`;
    card.setAttribute("aria-labelledby", titleId);
    card.dataset.panelDrawer = id;
    const head = document.createElement("header");
    const title = document.createElement("strong");
    title.id = titleId;
    title.textContent = record.label;
    const actions = document.createElement("span");
    actions.className = "managed-panel-actions";
    const pin = actionButton(`Pin ${record.label}`, () => setPreference(id, "column", pin));
    const minimize = actionButton(`Minimize ${record.label}`, () => setPreference(id, "minimized", minimize));
    const close = actionButton(`Close ${record.label} drawer`, () => closeDrawer(id));
    pin.textContent = "Pin column";
    minimize.textContent = "Minimize";
    close.textContent = "Close";
    actions.append(pin, minimize, close);
    head.append(title, actions);
    const body = document.createElement("div");
    body.className = "managed-panel-drawer-body";
    body.append(record.element);
    card.append(head, body);
    drawerHost.append(card);
    openDrawers.set(id, { card, close, restoreFocus: trigger });
    drawerOrder.push(id);
    record.element.dataset.presentation = "drawer";
    record.element.hidden = false;
    drawerHost.hidden = false;
    document.body.classList.add("panel-drawers-open");
    render();
    close.focus();
    onChange(id, "drawer");
  }

  function actionButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", handler);
    return button;
  }

  function setPreference(id, preference, trigger) {
    const record = records.get(id);
    if (!record || !["column", "minimized"].includes(preference)) return;
    removeDrawer(id);
    record.preference = preference;
    persist();
    render();
    onChange(id, preference);
    const target = preference === "minimized" ? rail.querySelector(`[data-panel-utility="${id}"]`) : trigger;
    if (target?.isConnected) target.focus();
  }

  function render() {
    for (const id of [...openDrawers.keys()]) {
      if (records.get(id)?.available?.() === false) closeDrawer(id, { focus: false });
    }
    rail.replaceChildren();
    records.forEach((record, id) => {
      record.element.querySelectorAll("[data-panel-action]").forEach((button) => {
        const action = button.dataset.panelAction;
        if (action !== "popout") button.setAttribute("aria-pressed", String(action === (openDrawers.has(id) ? "drawer" : record.preference)));
      });
      if (openDrawers.has(id)) return;
      returnToAnchor(record);
      record.element.dataset.presentation = record.preference;
      record.element.hidden = record.preference === "minimized";
      if (record.preference === "minimized" && record.available?.() !== false) {
        const button = actionButton(`Open ${record.label} drawer`, () => openDrawer(id, button));
        button.dataset.panelUtility = id;
        button.textContent = record.label;
        button.setAttribute("aria-controls", record.element.id);
        button.setAttribute("aria-expanded", "false");
        rail.append(button);
      }
    });
    rail.hidden = !rail.childElementCount;
  }

  render();
  records.forEach((record, id) => onChange(id, record.preference));
  return {
    openDrawer,
    closeDrawer,
    setPreference,
    refresh: render,
    isDrawerOpen: (id) => openDrawers.has(id),
    hasOpenDrawer: () => openDrawers.size > 0
  };
}

function readPreferences(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
