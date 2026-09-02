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

Fireworks and Groq Responses behavior differs from OpenAI; stateful response IDs should remain pinned to their originating physical provider. Together, DeepInfra, Cerebras, and Mistral are advertised as chat-only.
