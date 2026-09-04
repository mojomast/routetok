const MODELS = /^[A-Za-z0-9][A-Za-z0-9:._/-]{1,511}$/;
const IMAGE_EXTENSIONS = new Map([["png", "png"], ["jpg", "jpeg"], ["jpeg", "jpeg"], ["webp", "webp"], ["svg", "svg"]]);

export function normalizeLogicalImagePath(value, outputFormat = "auto") {
  if (typeof value !== "string" || !value || value.length > 180 || value.startsWith("/") || value.includes("\\") || /[%?#:\u0000-\u001f\u007f]/.test(value)) throw new Error("Image project path is unsafe");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) throw new Error("Image project path is unsafe");
  const extension = value.match(/\.([A-Za-z0-9]+)$/)?.[1].toLowerCase();
  const format = extension ? IMAGE_EXTENSIONS.get(extension) : null;
  if (!format) throw new Error("Image project path must use PNG, JPEG, WebP, or SVG");
  if (outputFormat !== "auto" && format !== outputFormat) throw new Error("Image project path extension does not match output format");
  return value;
}

export function validateImageRequest(value, revision) {
  const args = value?.arguments;
  if (!value || value.version !== 2 || value.tool !== "request_image" || !args || typeof args !== "object") throw new Error("Image request does not match Iteration Tool version 2");
  if (typeof value.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{1,64}$/.test(value.id)) throw new Error("Image request id is invalid");
  if (!MODELS.test(args.model || "") || typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 16_000) throw new Error("Image model or prompt is invalid");
  if (!["auto", "1:1", "16:9", "9:16", "4:3", "3:4"].includes(args.aspectRatio) || !["auto", "low", "medium", "high"].includes(args.quality) || !["auto", "png", "jpeg", "webp", "svg"].includes(args.outputFormat)) throw new Error("Image generation options are invalid");
  if (args.baseRevision !== revision) throw new Error(`Stale project revision: expected ${revision}`);
  const projectPath = normalizeLogicalImagePath(args.projectPath, args.outputFormat);
  if (typeof args.summary !== "string" || args.summary.length > 1_200) throw new Error("Image summary is invalid");
  return { ...args, projectPath, prompt: args.prompt.trim(), label: String(args.label || projectPath).slice(0, 120) };
}

export function createImageApprovals({ generate, validate, onResult, save, onStatus }) {
  let approving = false;
  async function approve(card, owner) {
    if (approving || card.status !== "pending") return;
    try { validate?.(card, owner); }
    catch (error) { card.status = "failed"; card.error = error.message; onStatus(error.message); await save(owner || card); return; }
    approving = true; card.status = "generating"; await save(owner || card);
    try {
      const result = await generate({ model: card.request.model, prompt: card.request.prompt, aspectRatio: card.request.aspectRatio, quality: card.request.quality, outputFormat: card.request.outputFormat });
      validate?.(card, owner);
      card.status = "generated"; await onResult(card, result, owner || card);
    } catch (error) { card.status = "failed"; card.error = error.message; onStatus(error.message); }
    finally { approving = false; await save(owner || card); }
  }
  async function reject(card, owner) { if (card.status !== "pending") return; card.status = "rejected"; await save(owner || card); }
  return { approve, reject };
}
