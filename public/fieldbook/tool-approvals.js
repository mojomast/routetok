export function createApprovalGate() {
  const active = new Map();
  let sequence = 0;
  function ask(call, context, present) {
    const id = ++sequence;
    const entry = { call, context, resolve: null };
    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    active.set(id, entry);
    present?.({ id, call, context, approve: () => decide(id, true), reject: () => decide(id, false) });
    return promise;
  }
  function decide(id, approved) {
    const entry = active.get(id);
    if (!entry) return false;
    active.delete(id);
    entry.resolve(Boolean(approved));
    return true;
  }
  return {
    ask,
    decide,
    pendingCount: () => active.size,
    hasPending: () => active.size > 0,
    rejectAll: () => { for (const [id] of active) decide(id, false); }
  };
}

export function approvalPreviewText(value, maximum = 2_000) {
  let text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return text.length > maximum ? `${text.slice(0, maximum)}\n… (${text.length.toLocaleString()} characters)` : text;
}

export function createApprovalCard({ document, call, onApprove, onReject }) {
  const article = document.createElement("article");
  article.className = "tool-approval";
  const heading = document.createElement("h3");
  heading.textContent = `Approve ${call.name}`;
  const body = document.createElement("div");
  const pre = document.createElement("pre");
  pre.className = "tool-approval-preview";
  pre.textContent = approvalPreviewText(call.args);
  body.append(pre);
  const actions = document.createElement("div");
  actions.className = "tool-approval-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "primary";
  approve.textContent = "Approve and run";
  approve.addEventListener("click", onApprove);
  const reject = document.createElement("button");
  reject.type = "button";
  reject.textContent = "Reject";
  reject.addEventListener("click", onReject);
  actions.append(approve, reject);
  article.append(heading, body, actions);
  return article;
}
