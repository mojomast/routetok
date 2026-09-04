export const TOOL_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
export const MAX_TOOLS = 16;

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "time_now",
    description: "Return the current UTC timestamp. Use it whenever the current time or date matters.",
    input_schema: { type: "object", properties: {} },
    gate: "auto"
  },
  {
    name: "catalog_lookup",
    description: "Search the enabled RouteTok model catalog for model ids, providers, pricing, context, and capabilities.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text to match against model id, display name, provider, or capability" },
        id: { type: "string", description: "Exact catalog model id to look up" }
      },
      additionalProperties: false
    },
    gate: "auto"
  },
  {
    name: "cost_estimate",
    description: "Estimate token usage and USD cost for a text against the current conversation model's advertised pricing.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text whose context and output cost should be estimated" },
        outputTokens: { type: "integer", description: "Optional assumed output tokens; otherwise the configured maximum" }
      },
      required: ["text"],
      additionalProperties: false
    },
    gate: "auto"
  },
  {
    name: "note_search",
    description: "Search this browser's saved Fieldbook notes by title and transcript content.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Free text to search for" } },
      required: ["query"],
      additionalProperties: false
    },
    gate: "auto"
  },
  {
    name: "note_read",
    description: "Read a saved Fieldbook note by id and return its prompt and response transcript.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The note id returned by note_search" } },
      required: ["id"],
      additionalProperties: false
    },
    gate: "auto"
  },
  {
    name: "scratchpad_read",
    description: "Read the current note's shared browser-local scratchpad document at its current revision.",
    input_schema: { type: "object", properties: {} },
    gate: "auto"
  },
  {
    name: "scratchpad_write",
    description: "Propose a unified diff against the current scratchpad. The user approves before any change is applied.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line summary of the intended edit" },
        diff: { type: "string", description: "Standard unified diff using --- scratchpad and +++ scratchpad headers" },
        baseRevision: { type: "integer", description: "Current scratchpad revision the diff is based on" }
      },
      required: ["summary", "diff", "baseRevision"],
      additionalProperties: false
    },
    gate: "approve"
  },
  {
    name: "studio_apply_patch",
    description: "Propose a unified diff against the virtual Studio project. The user approves before files change.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line summary of the intended change" },
        diff: { type: "string", description: "Unified diff with --- a/path and +++ b/path headers restricted to Studio files" },
        baseRevision: { type: "integer", description: "Current Studio project revision the diff is based on" }
      },
      required: ["summary", "diff", "baseRevision"],
      additionalProperties: false
    },
    gate: "approve"
  },
  {
    name: "image_request",
    description: "Request one ephemeral image generation through an enabled image model. The user approves before any provider call.",
    input_schema: {
      type: "object",
      properties: {
        model: { type: "string", description: "An enabled image generation model id" },
        prompt: { type: "string", description: "Full image prompt" },
        aspectRatio: { type: "string", enum: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"] },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
        outputFormat: { type: "string", enum: ["auto", "png", "jpeg", "webp", "svg"] },
        label: { type: "string", description: "Short human label for the approval card" }
      },
      required: ["model", "prompt"],
      additionalProperties: false
    },
    gate: "approve"
  }
]);

export const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
export const AUTO_TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.filter((tool) => tool.gate === "auto").map((tool) => tool.name));
export const APPROVAL_TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.filter((tool) => tool.gate === "approve").map((tool) => tool.name));

export function normalizeToolPolicy(value) {
  const policy = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const perTool = {};
  for (const tool of TOOL_DEFINITIONS) perTool[tool.name] = true;
  const source = policy.perTool && typeof policy.perTool === "object" && !Array.isArray(policy.perTool) ? policy.perTool : {};
  for (const tool of TOOL_DEFINITIONS) {
    if (typeof source[tool.name] === "boolean") perTool[tool.name] = source[tool.name];
  }
  return { enabled: policy.enabled !== false, perTool };
}

export function declarationsFor(names) {
  return names.map((name) => TOOL_BY_NAME.get(name)).filter(Boolean).slice(0, MAX_TOOLS)
    .map(({ name, description, input_schema }) => ({ name, description, input_schema: structuredClone(input_schema) }));
}

export function classifyTool(name) {
  const definition = TOOL_BY_NAME.get(name);
  if (!definition) return { known: false, gate: "unknown" };
  return { known: true, gate: definition.gate, definition };
}
