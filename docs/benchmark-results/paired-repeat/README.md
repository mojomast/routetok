# Frozen-policy repeat

Repeated unchanged paired-v1 cases/policy: 8 live Jev calls, 32 attempted generations. TypeSafe official introduction page re-fetched and still states $.042/M input, output free. WebXNG search returned empty this time; direct primary page used. Public price not invoice proof.

Observed replay router 7/8, DeepSeek 7/8, Qwen3.8Flash 8/8, GLM5.3Flash 4/8, GeminiLite 1/8. DeepSeek scheduling case timed out at 90s; replay shares that candidate response, so this is NOT an independent proxy success measurement. Qwen answered it correctly. Deterministic exact validators unchanged. No threshold or prompt tuned mid-run. Repeated tasks do not increase independent task count; results must be clustered by task in future inference.

Known reported generation spend $.0033456455, incomplete because timeout usage unknown. Jev reported 4942 tokens. Full savings comparison unavailable. Strict economics script correctly failed incomplete_paired_billing. The general summary initially silently treated unknown cost as zero; corrected it to null aggregate and null gross comparison, with known subtotal and missingBills separately. Regression test now exercises a missing-usage timeout and passes. Typecheck and full JS/TS suite pass. No production policy changes; secrets removed.

Findings: fixed inexpensive models remain necessary baselines. Qwen now passed both repeats on these cases, but cannot be declared best outside this narrow set. Generation prices and lengths vary; stable classification does not ensure stable cost. Prior pricing-adjusted pilot remains a net-cost regression estimate, not established savings. More live calls did NOT prove the desired claim, and no results have been discarded to make it appear otherwise.
