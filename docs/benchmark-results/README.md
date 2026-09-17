# Live matrix v1

Executed 48 real OpenRouter generations (12 cases x four models) and 24 real Jev classifications comparing old/new criteria. Scripts: `scripts/live-matrix.mjs` (OPENROUTER_API_KEY and unique BENCH_OUTPUT required); `scripts/live-classify.ts` (TYPESAFE_API_KEY, JEV_POLICY_FILE, cases path). No keys in repository. Generated cases include extraction, arithmetic, logic, code-reading, translation and literal formats. 512-token maximum, no retries, three concurrent generations, fixed interleaved order. Model catalog price checks and provider max_price cap .30 USD input / 1.20 USD output per million tokens. Fixed 48 requests and tiny prompts provide conservative $0.096 run ceiling; this is not a general-purpose shared budget ledger.

Results (checks passed / 12, total generation USD, median ms):
- Gemini 2.5 Flash Lite: 12, .0000346, 524
- GPT-4.1 Nano: 11, .0000457, 627
- DeepSeek V4 Flash 0731: 12, .0001748603, 1885.5
- DeepSeek V4.1 Flash: 12, .00047775, 1007.5

Nano added a preamble to email-only extraction. Verifiers normalize case and a trailing period/exclamation; they are NOT byte-exact strict-format validators. Raw data included for audit. No free models used. No generated code execution.

Old Jev mapping selected 9/12; revised descriptions selected 10/12, fixing email extraction and literal/JSON tasks but regressing two code-reading tasks to uncertainty. Same .8 threshold, no automatic fallback. New criteria cost more input tokens. They are preserved behind `taskTaxonomy: explicit-text-v2`, not made default. Legacy remains default. This is a direct live adapter comparison, NOT a new end-to-end proxy trial; downstream matrix was independently executed. It does not measure combined routing latency/savings or repeated stochastic behavior.

Jev usage 13382 tokens for these 24 calls; OpenRouter $0.0007329103 this round, cumulative reported $0.0019752253 including prior runs. No Jev dollar bill supplied. All calls stayed within previous authorization. Temporary credentials removed.

Each family had one development and one initially heldout case. Because both partitions were inspected while judging taxonomy changes, ALL cases now belong to development/regression data for future iterations. The paired variants are not independent enough for strong generalization claims. Full test suite and typecheck passed after changes.

Decision: no automatic policy promotion. Cheap Gemini is promising on these easy exact-answer tasks, but this dataset saturates and provides no evidence of a routing advantage over that fixed cheap baseline. Need substantially harder and independently sourced heldout tasks, repeated calls, strict validators and shadow evaluation before approving a new policy. Do not lower the quality evidence gate to make these tiny samples qualify.
