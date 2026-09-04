export const DEFAULT_MAX_TOOL_TURNS = 8;

function cloneMessages(messages) {
  return structuredClone(Array.isArray(messages) ? messages : []);
}

function appendTurn(transcript, turn) {
  transcript.push(turn);
  return turn;
}

export function createToolAgent({ dispatch, authorize, execute, requestApproval, maxToolTurns = DEFAULT_MAX_TOOL_TURNS, log = () => {} }) {
  async function run({ messages, tools = [], parameters = {}, signal, context = null }) {
    const transcript = cloneMessages(messages);
    const trajectory = [];
    const record = (entry) => { trajectory.push(entry); log(entry, transcript, trajectory); };
    let usedToolTurns = 0;
    let content = "";
    let metrics = null;
    let status = "complete";
    let error = null;
    const pendingCalls = [];
    while (true) {
      if (signal?.aborted) {
        status = "aborted";
        break;
      }
      let response;
      try {
        response = await dispatch({ messages: cloneMessages(transcript), tools, parameters, signal, context });
      } catch (dispatchError) {
        if (signal?.aborted || dispatchError?.name === "AbortError") {
          status = "aborted";
        } else {
          status = "error";
          error = dispatchError?.message || String(dispatchError);
        }
        break;
      }
      metrics = response?.metrics ?? metrics;
      content = response?.content ?? "";
      const calls = Array.isArray(response?.toolCalls) ? response.toolCalls.filter((call) => call && typeof call.id === "string" && typeof call.name === "string") : [];
      if (response?.error) {
        status = "error";
        error = response.error;
        appendTurn(transcript, { role: "assistant", content });
        record({ step: "model", content, error: response.error, metrics });
        break;
      }
      if (calls.length === 0) {
        appendTurn(transcript, { role: "assistant", content });
        record({ step: "model", content, metrics });
        break;
      }
      usedToolTurns += 1;
      if (usedToolTurns > maxToolTurns) {
        appendTurn(transcript, { role: "assistant", content, tool_calls: calls.map(callToWire) });
        record({ step: "model", content, toolCalls: calls.map(callToWire), metrics });
        for (const call of calls) {
          const refusal = `Tool budget reached after ${maxToolTurns} tool turns; ${call.name} was not executed.`;
          appendTurn(transcript, { role: "tool", tool_call_id: call.id, content: refusal, is_error: true });
          record({ step: "result", call, content: refusal, isError: true });
        }
        status = "budget";
        break;
      }
      appendTurn(transcript, { role: "assistant", content, tool_calls: calls.map(callToWire) });
      record({ step: "model", content, toolCalls: calls.map(callToWire), metrics });
      for (const call of calls) {
        pendingCalls.length = 0;
        const decision = await authorize(call, context);
        if (!decision || decision.allowed === false) {
          const reason = decision?.reason || `${call.name} is not allowed in this note`;
          appendTurn(transcript, { role: "tool", tool_call_id: call.id, content: reason, is_error: true });
          record({ step: "result", call, content: reason, isError: true });
          continue;
        }
        if (decision.approval === true) {
          let approved = false;
          try {
            approved = await requestApproval(call, context);
          } catch (approvalError) {
            if (signal?.aborted) {
              pendingCalls.push(call);
              status = "aborted";
              break;
            }
            const reason = approvalError?.message || "Approval was not completed";
            appendTurn(transcript, { role: "tool", tool_call_id: call.id, content: reason, is_error: true });
            record({ step: "result", call, content: reason, isError: true });
            continue;
          }
          record({ step: "approval", call, approved });
          if (!approved) {
            const reason = `${call.name} was rejected by the user`;
            appendTurn(transcript, { role: "tool", tool_call_id: call.id, content: reason, is_error: true });
            record({ step: "result", call, content: reason, isError: true });
            continue;
          }
        } else {
          record({ step: "approval", call, approved: true, automatic: true });
        }
        let resultContent;
        let isError = false;
        let media = null;
        try {
          const executed = await execute(call.name, call.args || {}, context);
          if (typeof executed === "string") {
            resultContent = executed;
          } else if (executed && typeof executed === "object") {
            resultContent = typeof executed.content === "string" ? executed.content : String(executed);
            if (Array.isArray(executed.media) && executed.media.length) media = executed.media;
          } else {
            resultContent = String(executed);
          }
        } catch (executeError) {
          isError = true;
          resultContent = executeError?.message || String(executeError);
        }
        appendTurn(transcript, { role: "tool", tool_call_id: call.id, name: call.name, content: resultContent, is_error: isError || undefined });
        record({ step: "result", call, content: resultContent, isError, ...(media ? { media } : {}) });
      }
      if (status === "aborted") break;
    }
    for (const call of pendingCalls) {
      const reason = "The run was stopped before this tool call could complete";
      appendTurn(transcript, { role: "tool", tool_call_id: call.id, content: reason, is_error: true });
      record({ step: "result", call, content: reason, isError: true });
    }
    if (trajectory.at(-1)?.step === "model" && usedToolTurns > 0 && status === "budget") record({ step: "end", status });
    return { status, content, error, metrics, transcript, trajectory };
  }
  return { run };
}

function callToWire(call) {
  return { id: call.id, name: call.name, args: call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {} };
}
