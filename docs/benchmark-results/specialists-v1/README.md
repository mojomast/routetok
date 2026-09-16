# Specialist screening v1

24 real OpenRouter calls, six models x four tasks. DeepSeek V4.1 Flash reference retained. Live catalog checked: GLM 5.3 Flash and Qwen 3.8 Flash exist and advertised below reference pricing. Other candidates: Qwen3 Coder 30B A3B Instruct, Nemotron 3.5 Lightning, Mistral Small 2603. No assumption that vendor specialization proves task suitability.

Runner: `OPENROUTER_API_KEY` privately configured, fresh `BENCH_OUTPUT`, then `node scripts/live-specialist-screen.mjs`. 4096 output cap, 90 second timeout, 6 workers, no retries, max provider input/output price .30/1.20 USD per million. At most 24 requests; conservative spend cap under $.25 with fixed small inputs. Response usage and finish reason retained. Synthetic cases only; no generated code execution. Python aliasing reference independently executed. Strict parsed JSON equality; fences fail.

| Model | Strict passes / 4 | Reported generation USD | Median ms | Length / timeout |
|---|---:|---:|---:|---:|
| GLM 5.3 Flash | 2 | .00312083505 | 27586.5 | 2 / 0 |
| Qwen 3.8 Flash | 2 | .00485821 | 25239.5 | 2 / 0 |
| DeepSeek V4.1 Flash | 2 | .008679 | 30440.5 | 2 / 0 |
| Nemotron 3.5 Lightning | 1 | .0025406 | 83616 | 2 / 1 |
| Qwen3 Coder 30B | 0 | .00044184 | 2282 | 0 / 0 |
| Mistral Small 2603 | 0 | .000933 | 736 | 0 / 0 |

Passing tasks for GLM/Qwen Flash/DeepSeek: Python aliasing trace and strict deduplicated extraction. Coder model got semantics wrong on both; not just formatting. Mistral extracted correct content but fenced JSON, a strict format failure, and got aliasing wrong. Nemotron passed extraction but code trace timed out. Hard extraction and optimization were not solved by any candidate; strongest candidates were length-limited. Do not interpret truncation as intrinsic inability, nor compare this run's 4096 budget to earlier 8192 run as if identical. One sample per cell; not sufficient for confidence or best-model certification.

Total reported cost $.02057348505, 67348 reported tokens. Timeout charge unknown, so not complete billing. No live Jev calls or production router change this round. Temporary credentials removed.

Recommended next candidate pool: GLM Flash for price-sensitive exact extraction/stateful tasks; Qwen Flash as alternate candidate; DeepSeek reference. These are hypotheses for repeated evaluation, not promoted mappings. Retain Mistral as cheap formatting-repair candidate only if explicit validation and full repair cost are measured. Do not promote Coder based on naming. Nemotron latency requires repeated checks before low-latency eligibility.

Jev-relevant features: code aliasing/state mutation versus generic coding; first-seen/deletion/version semantics versus generic extraction; hard global optimization; output-format strictness and expected reasoning budget. A confident family label does not establish these capabilities. Benchmark should report task-family success, format versus semantic failure, length termination, timeout rate, p50/p95, total reasoning/input/output tokens, and cost per successful task including classifier/repair. Unknown classifier bill must not become zero. None of these four-case results are sufficient for existing evidence quality floor; preserve opt-in gate.
