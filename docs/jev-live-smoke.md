# Live smoke: Jev + OpenRouter

Base 7016c8d, with Noul wire-contract fix in this branch. Synthetic prompts, real services; no mocked replies. Authorized limits $1 OpenRouter / 10 million Jev tokens. Three capped 256-output-token downstream requests, one successful direct Jev contract probe and one rejected 422 probe. No retries or alternate paid models.

Initial request failed HTTP 422 because Noul criteria was a string. Correct field is instructions; criteria optionally describes true/false outcomes. Fixed and added request-shape assertion. Observed revision: jev-1.13.0 (explicitly allowlisted for this test).

| Task | Jev family | Actual downstream | End-to-end ms | Jev ms | OpenRouter reported USD |
|---|---|---|---:|---:|---:|
| polite rewrite, one sentence | writing | google/gemini-2.5-flash-lite | 971 | 364 | 0.0000289 |
| Python add function | coding | openai/gpt-4.1-nano | 1216 | 179 | 0.0000093 |
| smallest positive common multiple of 12 and 18 | reasoning | deepseek/deepseek-v4.1-flash | 910 | 138 | 0.0000762 |

All 3 returned HTTP 200 through the real Routetok jev-auto endpoint. Family confidence was 1 in all cases; missing-requirement probabilities were .12, .10, .07. These are classification values, NOT downstream success rates. Timings include network and test instrumentation (response clone capture), not rigorous performance estimates.

Total OpenRouter reported cost $0.0001144, including reported reasoning tokens. Jev reported 2107 tokens across 4 successful calls. Rejected 422 had no usage field, so no token count is asserted for it. Jev dollar charge not available from these responses.

Quality: rewrite preserved Friday but returned four alternatives and a preamble instead of one sentence: instruction-following failure. Code returned correct-looking addition with Markdown fencing, not strictly raw code; not executable-tested here. Math returned exactly 36, correct. This small smoke establishes transport and policy routing, NOT quality calibration, best-model selection, net savings, or benchmark performance. Models were explicitly mapped by family, not learned from evidence. No free model used; all selected models' listed base token prices were at or below the specified flagship. Prices have time-based overrides; actual reported cost above is authoritative for these calls.

No credentials are included. Test server terminated after run. Live scripts/results reside outside the repository; this report records the observed run rather than providing a general live evaluation harness.
