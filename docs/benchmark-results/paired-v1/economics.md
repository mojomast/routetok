# Fully loaded cost correction

Verified official pricing directly at https://typesafe.ai/blog/introducing-system-one-models-and-jev after WebXNG/SearXNG search: Jev input $.042/million, output free. These are public list rates, not account invoice verification. Prior unknown-cost reports remain historically accurate, but economics.json now estimates their missing classifier cost.

Paired pilot: 4350 input tokens => $.0001827 classifier estimate. Router downstream $.00098285925 => total $.00116555925. Reference $.0010738. Thus apparent 8.47% gross saving becomes 8.55% estimated extra cost. Both paths 8/8 in that tiny development pilot, not established equal population quality.

Added strict numeric economics module, executable paired analyzer and regression checks proving positive gross savings can mean negative net savings. Missing paired usage causes analysis failure rather than manufactured zero billing. This does not change production routing or retrospectively prove live account charges.

Efficiency target: with downstream decisions unchanged, total classifier input must be below ~2165 tokens for the eight requests to break even, versus 4350 observed. Shortening prompts a little is not sufficient. Reducing classifier calls, choosing less expensive successful generations, or targeting workloads with larger absolute potential savings must be evaluated. Never truncate away user constraints to hit the target.

Prioritized experiments: compare fixed cheap/flagship/static-family policies against Jev with all costs; route explicitly selected models without classification (already supported); test opt-in tenant-scoped stable-session reuse only after detecting meaningful request changes and capability changes; compare compact atomic questions with existing questions on separate heldout data; measure reasoning-effort options through supported provider controls rather than guess their mapping. Cache decisions need tenant/policy/model-revision/privacy partitioning and tool-cycle affinity, so no unsafe global prompt cache is introduced.

Release gate remains quality noninferiority AND positive fully loaded cost interval. Do not tune on this eight-task pilot then reuse it as proof. No additional paid calls in this accounting increment. Typecheck and full suite pass.
