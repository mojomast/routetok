# Uncertainty handling increment

Rechecked https://docs.typesafe.ai/confidence.md: Choice confidence summarizes distribution shape, not downstream success; Noul has no confidence field; thresholds are domain-specific. WebXNG/SearXNG discovery returned no results on this pass; official documentation was retrieved directly instead. No new quality or live benefit claims.

Optional policy `uncertaintyFallback` must be an exact eligible model ID, e.g. `openrouter:deepseek/deepseek-v4.1-flash`. It handles low-confidence/mixed/unknown family and absent family mapping only. No fallback after missing essential information, protocol/privacy rejection, malformed API response, or infeasible configured family models. Paid model still requires existing Routetok enablement. This is a single replacement selection BEFORE generation, not an additional generation/retry. No default paid fallback and no claim of per-key atomic spend enforcement.

`clarificationThreshold` optionally controls missing-information probability threshold (0.5..1, default unchanged at 0.5). It is not automatically raised to suppress extraction failures: calibration still required. Missing information now returns HTTP 422 with `jev_clarification_required` and a clarification message. Other failures return a sanitized specific machine-readable reason instead of all being mislabeled abstentions; prompt/key/error-body content is not exposed. Recent dashboard API records retain these reasons.

Regression assertions exercise uncertain family with/without eligible fallback, missing information never falling back, model revision mismatch, infeasibility and unsupported tool history. Typecheck and full test suite pass.

This increment does NOT complete the broader plan: difficulty assessment, measured suitability registry, output validation and budgeted post-generation escalation, paired held-out evaluation harness, calibrated thresholds and billing-grade net savings remain outstanding. In particular, it does not establish that the extraction false-abstention or raw-code formatting failure has been fixed. No live paid calls were made in this increment.
