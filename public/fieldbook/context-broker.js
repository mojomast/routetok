export const CONTEXT_LIMITS = Object.freeze({ resources: 8, perResource: 60_000, total: 120_000 });

export function createContextBroker({ document, getResources, onStatus = () => {} }) {
  const selected = new Map();
  let activeScope = null;
  const dialog = document.createElement("dialog");
  dialog.className = "context-picker";
  dialog.innerHTML = `<form method="dialog"><header><div><strong>Attach context</strong><p>One-shot, frozen at send, and treated as untrusted data.</p></div><button value="cancel">Close</button></header><div class="context-picker-list"></div><footer><span>Maximum 8 resources · 60k each · 120k total</span><button value="default">Done</button></footer></form>`;
  document.body.append(dialog);

  document.querySelectorAll("[data-context-scope]").forEach((button) => {
    button.addEventListener("click", () => open(button.dataset.contextScope));
  });

  function available() {
    return (getResources() || []).filter((item) => item && typeof item.id === "string" && typeof item.content === "string");
  }

  function open(scope) {
    activeScope = scope;
    const list = dialog.querySelector(".context-picker-list");
    list.replaceChildren();
    const chosen = selected.get(scope) || new Set();
    for (const resource of available()) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = chosen.has(resource.id);
      checkbox.addEventListener("change", () => { checkbox.checked = toggle(scope, resource.id, checkbox.checked); });
      label.append(checkbox, document.createTextNode(`${resource.label} · ${resource.content.length.toLocaleString()} chars · ${resource.provenance}`));
      list.append(label);
    }
    dialog.showModal();
  }

  function toggle(scope, id, enabled) {
    const chosen = selected.get(scope) || new Set();
    if (enabled) {
      if (chosen.size >= CONTEXT_LIMITS.resources) {
        onStatus("Context is limited to 8 resources");
        renderChips(scope);
        return false;
      }
      chosen.add(id);
    } else chosen.delete(id);
    selected.set(scope, chosen);
    renderChips(scope);
    return chosen.has(id);
  }

  function renderChips(scope) {
    const host = document.querySelector(`[data-context-chips="${scope}"]`);
    if (!host) return;
    host.replaceChildren();
    const resources = new Map(available().map((item) => [item.id, item]));
    for (const id of selected.get(scope) || []) {
      const resource = resources.get(id);
      if (!resource) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "context-chip";
      chip.textContent = `${resource.label} ×`;
      chip.title = `${resource.provenance}; remove attachment`;
      chip.addEventListener("click", () => toggle(scope, id, false));
      host.append(chip);
    }
  }

  function consume(scope) {
    const chosen = selected.get(scope) || new Set();
    const resources = new Map(available().map((item) => [item.id, item]));
    const frozen = [...chosen].map((id) => resources.get(id)).filter(Boolean).map((item) => Object.freeze({
      id: item.id,
      label: item.label,
      revision: String(item.revision ?? "current"),
      provenance: item.provenance,
      content: item.content
    }));
    const oversized = frozen.find((item) => item.content.length > CONTEXT_LIMITS.perResource);
    const total = frozen.reduce((sum, item) => sum + item.content.length, 0);
    if (oversized) throw new Error(`“${oversized.label}” is ${oversized.content.length.toLocaleString()} characters; the per-resource limit is 60,000. Nothing was sent.`);
    if (total > CONTEXT_LIMITS.total) throw new Error(`Selected context is ${total.toLocaleString()} characters; the total limit is 120,000. Nothing was sent.`);
    selected.delete(scope);
    renderChips(scope);
    return Object.freeze(frozen);
  }

  return { consume, open, render: () => ["chat", "room", "studio"].forEach(renderChips), hasPickerOpen: () => dialog.open, closePicker: () => dialog.close() };
}

export function formatFrozenContext(resources) {
  if (!resources?.length) return "";
  return `\n\n<untrusted_attached_context>\n${resources.map((item) => `[${item.label}; revision=${item.revision}; provenance=${item.provenance}]\n${item.content}`).join("\n\n")}\n</untrusted_attached_context>`;
}
