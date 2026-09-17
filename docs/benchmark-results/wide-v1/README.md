# Wide candidate screen

112 real OpenRouter attempts: 14 models x 8 existing development tasks, four workers, 2048 output tokens, 90-second timeout, no retry, provider fallbacks disabled. Manifest preserves prompts and live catalog. No Jev calls. Price ceilings $.15/M input and $.60/M output; token bounds for this short-prompt run remain within prior $1 authorization. Known reported charges $.0061073445; failures with absent usage are not zero bills.

Best strict result: Mercury2.5 8/8 at $.00069232 and 1066ms median successful response latency. Fixed Qwen3.8 8/8 at $.00153195; DeepSeek4.1 7/8 at $.0018111 (scheduling exhausted token cap). Mercury's observed generation spend 61.77% below DeepSeek, 54.81% below Qwen. This is a fixed model advantage in a tiny inspected dataset, NOT Jev routing proof.

Ling3Flash 6/8 strict at $.000164829; GPT-OSS20B 7/8 at $.00020274. Ling translation capitalization is valid English; alias result wrapped in an object instead of requested array. GPT-OSS20B likewise wrapped scope answer. Added separately labeled case-insensitive translation sensitivity metric because original task did not require lowercase; no silent rewriting of historical strict scores. Nova Micro 0/8 strict includes both format and genuine semantic failures; not all failures are cognitive failures.

Free endpoint track: NemotronLightning 7/8 strict, all 8 HTTP200, reported zero charges, 32254.5ms median; Gemma4 free all 429; LagunaXS free 4 HTTP200 and 4 rate limits, 2 strict successes. GPT-OSS120B paid also had 5 rate limits; three successful requests passed. Rate limits are operational failures, not evidence of model incapability. These were not fresh dedicated quotas and concurrency/model order may affect availability. No retries attempted; repeat availability tests with pacing separately before concluding operational reliability.

Next candidates: Mercury for low-cost general baseline, Ling for routine work, GPT-OSS20B for reasoning/structured-output experiments, Nemotron free for latency-tolerant optional usage. All remain unpromoted. No representative heldout claims. Schema-only extraction model excluded because current text-only benchmark cannot exercise its required response_format fairly. Fresh independently sourced tasks and repetitions are required to validate advantages.

Runner exercised, summary generated, node syntax check and project typecheck pass. Credentials not embedded in committed code or artifacts.
