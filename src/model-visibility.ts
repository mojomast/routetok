import { catalogModelFreeStatus, isTextGenerationModel } from "./catalog.js";
import type { CatalogModel, ProviderId, RouterConfig } from "./types.js";

export type VisibilityReason = "unconfigured-provider" | "disabled" | "paid-needs-enable" | "unknown-price-needs-enable" | "image-only" | "not-text-capable";

export interface ModelVisibilityContext {
  config: RouterConfig;
  providerConfigured: Partial<Record<ProviderId, boolean>>;
}

export interface ModelVisibility {
  visible: boolean;
  reasons: VisibilityReason[];
}

function providerOf(model: CatalogModel): ProviderId {
  return model.providerId ?? "agentrouter";
}

function isImageOnly(model: CatalogModel): boolean {
  return Boolean(model.inputModalities && !model.inputModalities.includes("text"));
}

function isNotTextCapable(model: CatalogModel): boolean {
  if (!model.protocols.includes("openai")) return true;
  if (model.endpoints && !model.endpoints.some((endpoint) => endpoint === "chat" || endpoint === "responses")) return true;
  if (model.outputModalities && (model.outputModalities.length !== 1 || model.outputModalities[0] !== "text")) return true;
  if (model.providerId === "openrouter" && model.supportedParameters?.length) {
    return !model.supportedParameters.some((parameter) => parameter === "max_tokens" || parameter === "temperature" || parameter === "top_p" || parameter === "tools" || parameter === "reasoning");
  }
  return false;
}

export function visibilityOf(model: CatalogModel, ctx: ModelVisibilityContext): ModelVisibility {
  const reasons: VisibilityReason[] = [];
  const providerId = providerOf(model);
  if (!(ctx.providerConfigured[providerId] ?? false)) reasons.push("unconfigured-provider");
  if (ctx.config.disabledModels.includes(model.id)) reasons.push("disabled");
  if (isImageOnly(model)) reasons.push("image-only");
  if (isNotTextCapable(model)) reasons.push("not-text-capable");
  if (providerId !== "agentrouter" && !ctx.config.enabledExternalModels.includes(model.id)) {
    const freeStatus = catalogModelFreeStatus(model);
    if (freeStatus !== true) reasons.push(freeStatus === false ? "paid-needs-enable" : "unknown-price-needs-enable");
  }
  if (!isTextGenerationModel(model, "openai") && !reasons.includes("image-only") && !reasons.includes("not-text-capable")) {
    reasons.push("not-text-capable");
  }
  return { visible: reasons.length === 0, reasons };
}
