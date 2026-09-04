# Providers

All external routes are namespaced and unknown-price routes require explicit opt-in.

| ID | Default API root | Endpoints |
|---|---|---|
| `agentrouter` | `https://agentrouter.org` | OpenAI, Responses, Anthropic |
| `openrouter` | `https://openrouter.ai/api/v1` | Catalog-dependent |
| `requesty` | `https://router.requesty.ai/v1` | OpenAI and Anthropic |
| `opencode` | `https://opencode.ai/zen/v1` | Curated free routes |
| `kimi` | `https://api.kimi.com/coding/v1` | OpenAI, Responses, Anthropic |
| `groq` | `https://api.groq.com/openai/v1` | Chat and Responses |
| `together` | `https://api.together.ai/v1` | Chat |
| `fireworks` | `https://api.fireworks.ai/inference/v1` | Chat and Responses |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | Chat |
| `cerebras` | `https://api.cerebras.ai/v1` | Chat |
| `mistral` | `https://api.mistral.ai/v1` | Chat |
| `generic` | operator configured | Chat; Responses opt-in |

Catalog metadata varies by provider. RouteTok keeps missing capability and pricing data unknown rather than guessing. New providers never enter automatic or free routing unless explicitly configured.

The opt-in model metadata projection preserves those provider limitations and includes AgentRouter quality/completion ratios when supplied:

- AgentRouter's pricing feed currently supplies quality ratios, not token prices, context/output limits, or capability declarations. RouteTok does not reinterpret a quality ratio as a USD token rate.
- Kimi metadata is curated rather than a complete live upstream catalog.
- OpenCode metadata is mixed: curated RouteTok knowledge is combined with upstream catalog fields where available, with provenance retained.
- Generic-provider metadata depends on optional upstream catalog extensions. Standard OpenAI-compatible model lists commonly provide identity only, so limits, modalities, capabilities, parameters, and pricing may remain unknown.

Across all providers, `null` means unknown and `[]` means known empty. Zero is an observed zero, not a substitute for missing information. Known token rates are decimal strings in USD per million tokens; provider tier thresholds are token counts. Currency, unit, source, rates, and tiers remain nullable when the catalog cannot support a stronger claim.

OpenRouter also supplies catalog-confirmed text-to-speech and explicitly enabled image-output models to authenticated dashboard/Fieldbook endpoints. Requesty may supply transcription models when its live catalog advertises approved audio-input capability. A separately configured local Speaches service appears under the `local:` namespace and is not part of proxy fallback routing.

Fireworks and Groq Responses behavior differs from OpenAI; stateful response IDs should remain pinned to their originating physical provider. Together, DeepInfra, Cerebras, and Mistral are advertised as chat-only.
