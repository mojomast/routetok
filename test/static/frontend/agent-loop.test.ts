import assert from "node:assert/strict";
import test from "node:test";
// Browser modules are intentionally plain JavaScript and exercised directly here.
// @ts-expect-error No declaration file is emitted for static browser modules.
import { createToolAgent, DEFAULT_MAX_TOOL_TURNS } from "../../../public/fieldbook/agent-loop.js";
// @ts-expect-error No declaration file is emitted for static browser modules.
import { normalizeToolPolicy, declarationsFor, classifyTool, TOOL_DEFINITIONS } from "../../../public/fieldbook/tools.js";

type WireMessage = Record<string, unknown>;
type DispatchRequest = { messages: WireMessage[]; tools: WireMessage[]; signal: AbortSignal | null; parameters?: unknown };

function result(content: string, toolCalls: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return { content, toolCalls, metrics: null, error: null };
}

test("agent loop halts on final text and replays tool results into the transcript", async () => {
  const dispatched: WireMessage[][] = [];
  const executed: string[] = [];
  const loop = createToolAgent({
    dispatch: async (req: DispatchRequest) => {
      dispatched.push(req.messages);
      if (dispatched.length === 1) return result("", [{ id: "call_1", name: "time_now", args: {} }]);
      return result("The time is 12:00.");
    },
    authorize: () => ({ allowed: true, approval: false }),
    execute: async (name: string) => { executed.push(name); return '{"now":"12:00"}'; },
    requestApproval: async () => true
  });
  const outcome = await loop.run({ messages: [{ role: "user", content: "What time is it?" }], tools: [], signal: null });
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.content, "The time is 12:00.");
  assert.deepEqual(executed, ["time_now"]);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0]!.length, 1);
  const second = dispatched[1]!;
  assert.equal(second.length, 3);
  assert.equal(second[1]!.role, "assistant");
  assert.equal((second[1] as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id, "call_1");
  assert.equal(second[2]!.role, "tool");
  assert.equal((second[2] as { tool_call_id: string }).tool_call_id, "call_1");
  assert.equal(outcome.transcript.at(-1).role, "assistant");
  assert.equal(outcome.trajectory.some((entry: Record<string, unknown>) => entry.step === "result" && (entry.call as { name?: string })?.name === "time_now"), true);
});

test("gated tools pause for approval and are denied on rejection", async () => {
  const approvals: string[] = [];
  const executed: string[] = [];
  const loop = createToolAgent({
    dispatch: async (req: DispatchRequest) => {
      if (req.messages.some((message) => message.role === "tool" && message.is_error === true)) return result("Understood, nothing changed.");
      return result("", [{ id: "call_2", name: "scratchpad_write", args: { summary: "Note", diff: "--- a\n+++ b", baseRevision: 0 } }]);
    },
    authorize: () => ({ allowed: true, approval: true }),
    execute: async (name: string) => { executed.push(name); return '{"applied":true}'; },
    requestApproval: async (call: Record<string, unknown>) => { approvals.push(String(call.name)); return false; }
  });
  const outcome = await loop.run({ messages: [{ role: "user", content: "Update the scratchpad" }], tools: [], signal: null });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(approvals, ["scratchpad_write"]);
  assert.deepEqual(executed, []);
  assert.equal(outcome.transcript.some((message: WireMessage) => message.role === "tool" && message.is_error === true && /rejected/.test(String(message.content))), true);
});

test("unknown and disabled tools are denied without approval", async () => {
  const executed: string[] = [];
  const loop = createToolAgent({
    dispatch: async (req: DispatchRequest) => {
      if (req.messages.some((message) => message.role === "tool" && message.is_error === true)) return result("Ignored.");
      return result("", [{ id: "call_3", name: "shell_exec", args: {} }]);
    },
    authorize: (call: Record<string, unknown>) => ({ allowed: false, reason: `${call.name} is not a supported browser tool` }),
    execute: async (name: string) => { executed.push(name); return "unexpected"; },
    requestApproval: async () => true
  });
  const outcome = await loop.run({ messages: [{ role: "user", content: "Run a command" }], tools: [], signal: null });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(executed, []);
  assert.equal(outcome.transcript.some((message: WireMessage) => message.role === "tool" && /not a supported/.test(String(message.content))), true);
});

test("agent loop halts at the tool-turn budget and pairs pending calls with refusals", async () => {
  let dispatches = 0;
  const loop = createToolAgent({
    dispatch: async () => {
      dispatches += 1;
      return result("", [{ id: `call_${dispatches}`, name: "catalog_lookup", args: { query: "x" } }]);
    },
    authorize: () => ({ allowed: true, approval: false }),
    execute: async () => '{"ok":true}',
    requestApproval: async () => true,
    maxToolTurns: 2
  });
  const outcome = await loop.run({ messages: [{ role: "user", content: "loop" }], tools: [], signal: null });
  assert.equal(outcome.status, "budget");
  assert.equal(dispatches, 3);
  const trailing = outcome.transcript.at(-1);
  assert.equal(trailing.role, "tool");
  assert.equal(trailing.is_error, true);
  assert.match(String(trailing.content), /budget/i);
});

test("agent loop halts on abort", async () => {
  const controller = new AbortController();
  const loop = createToolAgent({
    dispatch: async (req: DispatchRequest) => {
      if (req.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return result("", [{ id: "call_4", name: "time_now", args: {} }]);
    },
    authorize: () => ({ allowed: true, approval: false }),
    execute: async () => '{"now":"x"}',
    requestApproval: async () => true
  });
  controller.abort();
  const outcome = await loop.run({ messages: [{ role: "user", content: "go" }], tools: [], signal: controller.signal });
  assert.equal(outcome.status, "aborted");
});

test("tool registry normalizes per-note policy and classifies every declaration", async () => {
  assert.equal(DEFAULT_MAX_TOOL_TURNS, 8);
  assert.equal(TOOL_DEFINITIONS.length, 9);
  assert.equal(classifyTool("not_a_tool").known, false);
  const policy = normalizeToolPolicy({ enabled: true, perTool: { image_request: false } });
  assert.equal(policy.enabled, true);
  assert.equal(policy.perTool.image_request, false);
  assert.equal(policy.perTool.time_now, true);
  const names = TOOL_DEFINITIONS.filter((tool: { name: string }) => policy.perTool[tool.name] !== false).map((tool: { name: string }) => tool.name);
  assert.deepEqual(names.includes("image_request"), false);
  const declarations = declarationsFor(names);
  assert.equal(declarations.length, 8);
  assert.equal(declarations.every((tool: { name: string; description: string; input_schema: object }) => Boolean(tool.name && tool.description && tool.input_schema && typeof tool.input_schema === "object")), true);
  assert.equal(normalizeToolPolicy(null).enabled, true);
  assert.equal(classifyTool("scratchpad_write").gate, "approve");
  assert.equal(classifyTool("note_search").gate, "auto");
});
