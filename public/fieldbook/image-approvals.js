const MODELS = /^[A-Za-z0-9][A-Za-z0-9:._/-]{1,511}$/;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,179}$/;

export function validateImageRequest(value, revision) {
  const args = value?.arguments;
  if (!value || value.version !== 2 || value.tool !== "request_image" || !args || typeof args !== "object") throw new Error("Image request does not match Iteration Tool version 2");
  if (typeof value.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{1,64}$/.test(value.id)) throw new Error("Image request id is invalid");
  if (!MODELS.test(args.model || "") || typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 16_000) throw new Error("Image model or prompt is invalid");
  if (!["auto", "1:1", "16:9", "9:16", "4:3", "3:4"].includes(args.aspectRatio) || !["auto", "low", "medium", "high"].includes(args.quality) || !["png", "jpeg", "webp", "svg"].includes(args.outputFormat)) throw new Error("Image generation options are invalid");
  if (args.baseRevision !== revision) throw new Error(`Stale project revision: expected ${revision}`);
  if (args.projectPath && (!PATH.test(args.projectPath) || args.projectPath.includes(".."))) throw new Error("Image project path is unsafe");
  if (typeof args.summary !== "string" || args.summary.length > 1_200) throw new Error("Image summary is invalid");
  return { ...args, prompt: args.prompt.trim(), label: String(args.label || args.projectPath || "Generated image").slice(0, 120) };
}

export function createImageApprovals({ generate, validate, onResult, save, onStatus }) {
  let approving = false;
  async function approve(card) {
    if (approving || card.status !== "pending") return;
    try { validate?.(card); }
    catch (error) { card.status = "failed"; card.error = error.message; onStatus(error.message); await save(); return; }
    approving = true; card.status = "generating"; await save();
    try {
      const result = await generate({ model: card.request.model, prompt: card.request.prompt, aspectRatio: card.request.aspectRatio, quality: card.request.quality, outputFormat: card.request.outputFormat });
      card.status = "generated"; await onResult(card, result);
    } catch (error) { card.status = "failed"; card.error = error.message; onStatus(error.message); }
    finally { approving = false; await save(); }
  }
  async function reject(card) { if (card.status !== "pending") return; card.status = "rejected"; await save(); }
  return { approve, reject };
}
