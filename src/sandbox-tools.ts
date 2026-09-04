import type { Protocol, SandboxTool, SandboxToolCall, SandboxToolCallTurn, SandboxToolResultTurn, SandboxTranscriptTurn } from "./types.js";

export const MAX_SANDBOX_TOOLS = 16;
export const MAX_TRANSCRIPT_MESSAGES = 40;
export const MAX_TRANSCRIPT_CHARACTERS = 500_000;
export const MAX_TOOL_DESCRIPTION_CHARACTERS = 2_000;
export const MAX_TOOL_SCHEMA_NODES = 2_000;

const TOOL_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function boundedJsonSchema(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 100_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.length <= 200 && value.every((item) => boundedJsonSchema(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return true;
  if (entries.length > 100) return false;
  return entries.every(([key, item]) => key.length <= 200 && boundedJsonSchema(item, depth + 1));
}

export function validToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME_PATTERN.test(name);
}

export function parseSandboxTools(value: unknown): SandboxTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Sandbox tools must be an array of 1 to ${MAX_SANDBOX_TOOLS} tools`);
  if (value.length === 0) return [];
  if (value.length > MAX_SANDBOX_TOOLS) {
    throw new Error(`Sandbox tools must be an array of 1 to ${MAX_SANDBOX_TOOLS} tools`);
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Sandbox tool ${index + 1} must be an object`);
    const item = entry as Record<string, unknown>;
    if (!validToolName(item.name) || names.has(item.name)) {
      throw new Error(`Sandbox tool names must be unique and match ^[a-z0-9_]{1,64}$`);
    }
    if (typeof item.description !== "string" || item.description.length > MAX_TOOL_DESCRIPTION_CHARACTERS) {
      throw new Error(`Sandbox tool ${String(item.name)} description must be a string of at most ${MAX_TOOL_DESCRIPTION_CHARACTERS} characters`);
    }
    if (!item.input_schema || typeof item.input_schema !== "object" || Array.isArray(item.input_schema)) {
      throw new Error(`Sandbox tool ${String(item.name)} requires an object input_schema`);
    }
    const schema = item.input_schema as Record<string, unknown>;
    if (!boundedJsonSchema(schema)) throw new Error(`Sandbox tool ${String(item.name)} input_schema exceeds the bounded JSON schema limits`);
    names.add(item.name);
    return { name: item.name, description: item.description, input_schema: structuredClone(schema) };
  });
}

function transcriptText(value: string, totalCharacters: { current: number }): string {
  if (value.length > 100_000) throw new Error("Every chat message must be at most 100,000 characters");
  totalCharacters.current += value.length;
  if (totalCharacters.current > MAX_TRANSCRIPT_CHARACTERS) throw new Error("Chat history exceeds 500,000 characters");
  return value;
}

export function parseSandboxTranscript(value: unknown): SandboxTranscriptTurn[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRANSCRIPT_MESSAGES) {
    throw new Error("Chat requires between 1 and 40 messages");
  }
  const totalCharacters = { current: 0 };
  const pendingCalls = new Map<string, string>();
  const seenResults = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Every chat message must be an object");
    const message = entry as Record<string, unknown>;
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !CALL_ID_PATTERN.test(message.tool_call_id)) {
        throw new Error("Tool result tool_call_id is invalid");
      }
      const expectedName = pendingCalls.get(message.tool_call_id);
      if (!expectedName) throw new Error(`Tool result references an unknown tool call: ${String(message.tool_call_id)}`);
      if (seenResults.has(message.tool_call_id)) throw new Error(`Tool result repeats a resolved tool call: ${String(message.tool_call_id)}`);
      seenResults.add(message.tool_call_id);
      if (typeof message.name === "string" && message.name !== expectedName) {
        throw new Error(`Tool result name does not match tool call ${String(message.tool_call_id)}`);
      }
      if (typeof message.content !== "string" || !message.content.trim()) {
        throw new Error("Tool result content must be a non-empty string");
      }
      transcriptText(message.content, totalCharacters);
      const turn: SandboxToolResultTurn = { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
      if (message.is_error === true) turn.is_error = true;
      return turn;
    }
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new Error("Chat message role must be system, user, assistant, or tool");
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0 || message.tool_calls.length > 8) {
        throw new Error("Assistant tool calls must be an array of 1 to 8 calls");
      }
      const content = typeof message.content === "string" ? transcriptText(message.content, totalCharacters) : "";
      const ids = new Set<string>();
      const toolCalls = message.tool_calls.map((call) => {
        if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("Every tool call must be an object");
        const callValue = call as Record<string, unknown>;
        if (typeof callValue.id !== "string" || !CALL_ID_PATTERN.test(callValue.id) || ids.has(callValue.id)) {
          throw new Error("Tool call ids must be unique and match ^[A-Za-z0-9_-]{1,128}$");
        }
        if (!validToolName(callValue.name)) throw new Error("Tool call names must match ^[a-z0-9_]{1,64}$");
        if (!callValue.args || typeof callValue.args !== "object" || Array.isArray(callValue.args)) {
          throw new Error("Tool call arguments must be a JSON object");
        }
        const args = callValue.args as Record<string, unknown>;
        if (!boundedJsonSchema(args)) throw new Error("Tool call arguments exceed the bounded JSON limits");
        ids.add(callValue.id);
        pendingCalls.set(callValue.id, callValue.name);
        transcriptText(JSON.stringify(args), totalCharacters);
        return { id: callValue.id, name: callValue.name, args: structuredClone(args) } as SandboxToolCall;
      });
      return { role: "assistant", content, tool_calls: toolCalls } as SandboxToolCallTurn;
    }
    if (message.role !== "assistant" && message.tool_calls !== undefined) {
      throw new Error("Only assistant messages may declare tool calls");
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new Error("Chat message content must be a non-empty string");
    }
    transcriptText(message.content, totalCharacters);
    return { role: message.role, content: message.content };
  });
}

export function isToolCallTurn(turn: SandboxTranscriptTurn): turn is SandboxToolCallTurn {
  return turn.role === "assistant" && "tool_calls" in turn;
}

export function transcriptHasTools(turns: SandboxTranscriptTurn[]): boolean {
  return turns.some((turn) => turn.role === "tool" || isToolCallTurn(turn));
}

export function openAiWireTools(tools: SandboxTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
  }));
}

export function openAiWireMessages(turns: SandboxTranscriptTurn[]): Array<Record<string, unknown>> {
  return turns.map((turn) => {
    if (isToolCallTurn(turn)) {
      return {
        role: "assistant",
        content: turn.content,
        tool_calls: turn.tool_calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) }
        }))
      };
    }
    if (turn.role === "tool") {
      return { role: "tool", tool_call_id: turn.tool_call_id, content: turn.content };
    }
    return { role: turn.role, content: turn.content };
  });
}

export function anthropicWireTools(tools: SandboxTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
}

export function anthropicWirePayload(turns: SandboxTranscriptTurn[]): { system: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  let toolResults: SandboxToolResultTurn[] = [];
  const flushToolResults = () => {
    if (!toolResults.length) return;
    messages.push({
      role: "user",
      content: toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.tool_call_id,
        ...(result.is_error === true ? { is_error: true } : {}),
        content: result.content
      }))
    });
    toolResults = [];
  };
  for (const turn of turns) {
    if (turn.role === "tool") {
      toolResults.push(turn);
      continue;
    }
    flushToolResults();
    if (turn.role === "system") {
      systemParts.push(turn.content);
      continue;
    }
    if (isToolCallTurn(turn)) {
      const blocks: Array<Record<string, unknown>> = [];
      if (turn.content) blocks.push({ type: "text", text: turn.content });
      for (const call of turn.tool_calls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    messages.push({ role: turn.role, content: turn.content });
  }
  flushToolResults();
  return { system: systemParts.join("\n\n"), messages };
}

function parseCallArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const candidates = trimmed.startsWith("{") ? [trimmed, trimmed.replace(/,\s*([}\]])/g, "$1")] : [];
  for (const candidate of [...candidates, `{${trimmed}}`]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Fall through to the next candidate.
    }
  }
  return {};
}

export function createOpenAiToolCallAccumulator() {
  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  return {
    consume(delta: Record<string, unknown>): void {
      if (!Array.isArray(delta.tool_calls)) return;
      for (const item of delta.tool_calls) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const call = item as Record<string, unknown>;
        if (!Number.isInteger(call.index)) continue;
        const index = Number(call.index);
        let entry = pending.get(index);
        if (!entry) {
          entry = { id: "", name: "", arguments: "" };
          pending.set(index, entry);
        }
        if (typeof call.id === "string") entry.id = call.id;
        const fn = call.function && typeof call.function === "object" && !Array.isArray(call.function)
          ? call.function as Record<string, unknown>
          : {};
        if (typeof fn.name === "string") entry.name = fn.name;
        if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
      }
    },
    finish(): SandboxToolCall[] {
      const calls: SandboxToolCall[] = [...pending.entries()]
        .sort((left, right) => left[0] - right[0])
        .flatMap(([, entry]) => {
          if (!CALL_ID_PATTERN.test(entry.id) || !validToolName(entry.name)) return [];
          return [{ id: entry.id, name: entry.name, args: parseCallArguments(entry.arguments) }];
        });
      pending.clear();
      return calls;
    }
  };
}

export function createAnthropicToolUseAccumulator() {
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  return {
    consume(event: Record<string, unknown>): void {
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "content_block_start") {
        const block = event.content_block && typeof event.content_block === "object" && !Array.isArray(event.content_block)
          ? event.content_block as Record<string, unknown>
          : {};
        if (block.type === "tool_use" && Number.isInteger(event.index)) {
          blocks.set(Number(event.index), {
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            json: ""
          });
        }
        return;
      }
      if (type === "content_block_delta") {
        const index = Number(event.index);
        const entry = blocks.get(index);
        if (!entry) return;
        const delta = event.delta && typeof event.delta === "object" && !Array.isArray(event.delta)
          ? event.delta as Record<string, unknown>
          : {};
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") entry.json += delta.partial_json;
        return;
      }
      if (type === "content_block_stop" && Number.isInteger(event.index)) {
        const entry = blocks.get(Number(event.index));
        if (entry) {
          entry.json = entry.json.trim();
          if (entry.json && !entry.json.startsWith("{")) entry.json = `{${entry.json}}`;
        }
      }
    },
    finish(): SandboxToolCall[] {
      const calls: SandboxToolCall[] = [...blocks.entries()]
        .sort((left, right) => left[0] - right[0])
        .flatMap(([, entry]) => {
          if (!CALL_ID_PATTERN.test(entry.id) || !validToolName(entry.name)) return [];
          return [{ id: entry.id, name: entry.name, args: parseCallArguments(entry.json) }];
        });
      blocks.clear();
      return calls;
    }
  };
}

export function transcriptToolCallIds(turns: SandboxTranscriptTurn[]): Set<string> {
  return new Set(turns.flatMap((turn) => isToolCallTurn(turn) ? turn.tool_calls.map((call) => call.id) : []));
}

export function normalizeProtocol(protocol: unknown, modelProtocols: Protocol[] | undefined, modelId: string): Protocol {
  if (protocol === undefined) return "openai";
  if (protocol !== "openai" && protocol !== "anthropic") throw new Error("Sandbox protocol must be openai or anthropic");
  if (modelProtocols && !modelProtocols.includes(protocol)) throw new Error(`Model is unavailable over ${protocol}: ${modelId}`);
  return protocol;
}
