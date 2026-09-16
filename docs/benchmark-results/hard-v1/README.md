# Hard benchmark v1 — real provider run

12 deterministic cases x 4 inexpensive models, 48 recorded outcomes. 8192 output-token cap, 180-second request timeout, four concurrent workers. Exact parsed JSON equality (key order ignored); no stripping fences, no model judges. This is a stress/development benchmark, not heldout evidence of production quality.

Families: 140-event ledger replay with consumed IDs, duplicate IDs, insufficient funds and eight balances; 16-project constrained optimization with budget/group limits and lexicographic tie-break (ground truth exhaustive enumeration); 180-record versioned extraction with active/deleted state and last-record tie-breaking. Four deterministic seeds per family. Generator and independent dynamic-programming optimum check included; ledger conservation/nonnegative invariants pass.

Results:
- Gemini 2.5 Flash Lite: 0/12, all responses finished normally but failed exact answer.
- GPT-4.1 Nano: 0/12, all responses finished normally but failed exact answer.
- DeepSeek V4.1 Flash: 4/12 (one ledger, three extraction), five length-limited, three timeouts.
- DeepSeek V4 Flash 0731: 1/12 (ledger), three length-limited, eight timeouts.

Nobody passed optimization. This is not evidence all models are incapable: timeout and reasoning budget are part of the measured service contract. Distinguish incorrect completed answers from unavailable/truncated answers. Increasing output limits or using tools could change outcomes. These families overrepresent exact symbolic work; they are not a representative general assistant workload.

199901 provider-reported tokens, $0.092161436 reported cost. Missing timeout/interrupted usage means actual charge may be higher; no fabricated zero billing. Initial foreground tool was terminated at 420 seconds after 25 results. Resumed only pairs without results, but up to four interrupted in-flight attempts could have been billed and later repeated. Conservative ceiling for 52 attempts at configured price/output/input caps stays below prior $1 authorization. No new Jev calls in this run: isolate candidate competence before refining classifier. No combined router-quality claim.

Reproduce: python3 scripts/generate-hard-benchmark.py; python3 scripts/test-hard-ground-truth.py; OPENROUTER_API_KEY via private environment then node scripts/live-hard-matrix.mjs. Runner uses /tmp/routetok-hard-cases.json and resumable /tmp/routetok-hard-results.jsonl; use fresh output for a new experiment. Synthetic prompts/responses and expected answers committed here, no credentials. Generator is deterministic; do not treat new seeds of identical templates as independently sourced holdout.

Implications: previous cheap-model success was benchmark saturation. Hard state/extraction should not inherit the generic writing mapping. A stronger model helps but still cannot meet high reliability at this budget. Optimization/state transformations should use deterministic computation where available, otherwise explicit inability/verification, not blind fallback. Need a difficulty ladder between prior easy suite and this hard suite, plus independently sourced coding/long-form tasks. Keep evidence gate enabled only with genuinely sufficient representative samples. No production mapping is promoted based on these 12 cases.
