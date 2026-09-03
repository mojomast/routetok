const STORAGE_KEY = "routetok-fieldbook-panel-preferences-v1";

export function createPanelManager({ document, storage, panels, onPopout, onChange = () => {} }) {
  const saved = readPreferences(storage);
  const records = new Map();
  let drawerId = null;
  let restoreFocus = null;
  let inerted = [];

  const rail = document.createElement("nav");
  rail.className = "panel-utility-rail";
  rail.setAttribute("aria-label", "Minimized panels");
  const drawer = document.createElement("section");
  drawer.className = "managed-panel-drawer";
  drawer.hidden = true;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  const drawerHead = document.createElement("header");
  const drawerTitle = document.createElement("strong");
  const drawerClose = document.createElement("button");
  drawerClose.type = "button";
  drawerClose.textContent = "Close";
  drawerHead.append(drawerTitle, drawerClose);
  const drawerBody = document.createElement("div");
  drawer.append(drawerHead, drawerBody);
  document.body.append(rail, drawer);

  for (const definition of panels) {
    const element = document.getElementById(definition.elementId);
    if (!element) continue;
    const anchor = document.createComment(`panel:${definition.id}`);
    element.before(anchor);
    const preference = saved[definition.id] === "minimized" ? "minimized" : "column";
    records.set(definition.id, { ...definition, element, anchor, preference });
    bindControls(element, definition.id);
  }

  function bindControls(element, id) {
    element.querySelectorAll("[data-panel-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.panelAction;
        if (action === "drawer") openDrawer(id, button);
        else if (action === "column") setPreference(id, "column");
        else if (action === "minimize") setPreference(id, "minimized");
        else if (action === "popout") onPopout?.(id);
      });
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

  function closeDrawer({ focus = true } = {}) {
    if (!drawerId) return false;
    const record = records.get(drawerId);
    if (record) returnToAnchor(record);
    drawerId = null;
    drawer.hidden = true;
    document.body.classList.remove("panel-drawer-open");
    for (const element of inerted) element.inert = false;
    inerted = [];
    render();
    if (record) onChange(record.id, record.preference);
    if (focus && restoreFocus?.isConnected) restoreFocus.focus();
    restoreFocus = null;
    return true;
  }

  function openDrawer(id, trigger = document.activeElement) {
    const record = records.get(id);
    if (!record || record.available?.() === false) return;
    closeDrawer({ focus: false });
    drawerId = id;
    restoreFocus = trigger;
    drawerTitle.textContent = record.label;
    drawerBody.append(record.element);
    record.element.dataset.presentation = "drawer";
    record.element.hidden = false;
    drawer.hidden = false;
    document.body.classList.add("panel-drawer-open");
    inerted = [...document.body.children].filter((element) => element !== drawer && !element.inert);
    for (const element of inerted) element.inert = true;
    drawerClose.focus();
    onChange(id, "drawer");
  }

  function setPreference(id, preference) {
    const record = records.get(id);
    if (!record || !["column", "minimized"].includes(preference)) return;
    if (drawerId === id) closeDrawer({ focus: false });
    record.preference = preference;
    persist();
    render();
    onChange(id, preference);
  }

  function render() {
    if (drawerId && records.get(drawerId)?.available?.() === false) closeDrawer({ focus: false });
    rail.replaceChildren();
    records.forEach((record, id) => {
      if (drawerId === id) return;
      returnToAnchor(record);
      record.element.dataset.presentation = record.preference;
      record.element.hidden = record.preference === "minimized";
      if (record.preference === "minimized" && record.available?.() !== false) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Restore ${record.label}`;
        button.addEventListener("click", () => setPreference(id, "column"));
        rail.append(button);
      }
    });
    rail.hidden = !rail.childElementCount;
  }

  drawerClose.addEventListener("click", () => closeDrawer());
  drawer.addEventListener("click", (event) => { if (event.target === drawer) closeDrawer(); });
  drawer.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  render();
  records.forEach((record, id) => onChange(id, record.preference));
  return { openDrawer, closeDrawer, setPreference, refresh: render, hasOpenDrawer: () => Boolean(drawerId) };
}

function readPreferences(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
