export function createStudioChat({ document, getConversation, getStudio, isActive, request, buildMessages, parseResponse, acceptProposal, save, renderText, metricText, uid, now, onStatus }) {
  const $ = (id) => document.getElementById(id);
  let controller = null;

  function normalize(studio = getStudio(getConversation())) {
    if (!studio.chat || typeof studio.chat !== "object" || Array.isArray(studio.chat)) studio.chat = { messages: [], draft: "", pending: null };
    studio.chat.messages = Array.isArray(studio.chat.messages) ? studio.chat.messages.slice(-80) : [];
    studio.chat.draft = typeof studio.chat.draft === "string" ? studio.chat.draft.slice(0, 50_000) : "";
    return studio.chat;
  }

  function render() {
    const conversation = getConversation();
    const studio = getStudio(conversation);
    const chat = normalize(studio);
    const timeline = $("studio-chat-timeline");
    if (!timeline) return;
    timeline.replaceChildren();
    for (const message of chat.messages) {
      const article = document.createElement("article");
      article.className = `studio-chat-message ${message.role}`;
      const header = document.createElement("header");
      header.textContent = `${message.role === "user" ? "You" : message.agent || "Agent"} · ${new Date(message.createdAt).toLocaleString()}`;
      const body = document.createElement("div");
      renderText(body, message.content);
      article.append(header, body);
      if (message.context?.length) {
        const attached = document.createElement("small");
        attached.className = "attached-context";
        attached.textContent = `Context: ${message.context.map((item) => `${item.label} (${item.provenance}, rev ${item.revision})`).join(" · ")}`;
        article.append(attached);
      }
      if (message.metrics) { const footer = document.createElement("footer"); footer.textContent = metricText(message.metrics); article.append(footer); }
      if (message.proposal && message.proposal.status === "pending") {
        const actions = document.createElement("div");
        actions.className = "proposal-actions";
        const accept = document.createElement("button"); accept.type = "button"; accept.className = "primary"; accept.textContent = "Accept patch";
        const reject = document.createElement("button"); reject.type = "button"; reject.textContent = "Reject";
        accept.onclick = async () => {
          if (!confirm(`Apply this proposal to Studio revision ${message.proposal.baseRevision}?`)) return;
          try { acceptProposal(message.proposal, conversation); message.proposal.status = "accepted"; await save(conversation); if (isActive(conversation)) render(); }
          catch (error) { onStatus(error.message); }
        };
        reject.onclick = async () => { message.proposal.status = "rejected"; await save(conversation); if (isActive(conversation)) render(); };
        actions.append(accept, reject); article.append(actions);
      } else if (message.proposal) {
        const state = document.createElement("p"); state.className = "proposal-state"; state.textContent = `Patch ${message.proposal.status}; project ${message.proposal.status === "accepted" ? "updated" : "unchanged"}.`; article.append(state);
      }
      timeline.append(article);
    }
    if (document.activeElement !== $("studio-chat-draft")) $("studio-chat-draft").value = chat.draft;
    const picker = $("studio-chat-agent"); const selected = picker.value;
    picker.replaceChildren(new Option(`Next agent · ${studio.agents[studio.nextAgent]?.name || "Agent"}`, "next"));
    studio.agents.forEach((agent, index) => picker.append(new Option(agent.name, String(index))));
    picker.value = [...picker.options].some((option) => option.value === selected) ? selected : "next";
    const busy = controller?.conversation === conversation;
    $("studio-chat-draft").disabled = busy;
    $("send-studio-chat").disabled = busy;
    $("stop-studio-chat").hidden = !busy;
  }

  async function send(frozenContext = []) {
    if (controller) return onStatus("Wait for the active steering response or stop it");
    const conversation = getConversation();
    const studio = getStudio(conversation); const chat = normalize(studio); const input = $("studio-chat-draft"); const content = input.value.trim();
    if (!content) return;
    const choice = $("studio-chat-agent").value;
    const agentIndex = choice === "next" ? studio.nextAgent : Number(choice);
    const agent = studio.agents[agentIndex];
    if (!agent) return onStatus("Choose an agent");
    const user = { id: uid("studioChat"), role: "user", content, agent: agent.name, createdAt: now(), context: frozenContext };
    controller = { abortController: new AbortController(), conversation }; chat.messages.push(user); chat.draft = ""; input.value = ""; render(); await save(conversation);
    try {
      const result = await request(agent, buildMessages(studio, agent, content, frozenContext), controller.abortController.signal, conversation);
      const parsed = parseResponse(result.content || result.reasoning || "", studio, agent);
      chat.messages.push({ id: uid("studioChat"), role: "assistant", agent: agent.name, content: parsed.advisory, proposal: parsed.proposal, metrics: result.metrics, createdAt: now() });
    } catch (error) {
      chat.messages.push({ id: uid("studioChat"), role: "assistant", agent: agent.name, content: error.name === "AbortError" ? "Steering response cancelled." : `Steering response failed: ${error.message}`, createdAt: now() });
    }
    controller = null; chat.messages = chat.messages.slice(-80); await save(conversation); if (isActive(conversation)) render();
  }

  function stop() { controller?.abortController.abort(); }

  $("studio-chat-draft")?.addEventListener("input", (event) => { const conversation = getConversation(); normalize(getStudio(conversation)).draft = event.target.value; save(conversation); });
  return { normalize, render, send, stop };
}
