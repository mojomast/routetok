# Experimental Jev routing — draft, disabled by default

Research used WebXNG/SearXNG discovery and direct official docs:
- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/api
- https://github.com/lm-sys/RouteLLM (workload-specific threshold calibration)

TypeSafe specifies independent typed questions: Choice confidence is derived from its distribution, not a downstream success probability; Noul returns yes-probability without separate confidence. This implementation asks task family and missing essential requirements separately, combines them in code, and never asks Jev to calculate cost or invent endpoints. Ambiguous, mixed and unknown tasks abstain. Route order is operator-declared, not evidence that cheapest/strongest is optimal. Thresholds require calibration; no universal default or live quality claims.

## Opt-in

Set TYPESAFE_API_KEY privately and JEV_POLICY_FILE to an operator-controlled JSON file:

```json
{"authorizeExternal":true,"acceptedModels":["jev-latest"],"timeoutMs":1500,"minConfidence":0.9,"routes":{"coding":["provider:reviewed-model"],"writing":["provider:reviewed-model"]}}
```

IDs are placeholders, not verified recommendations. acceptedModels is an exact allowlist of reported aliases/revisions: update after live contract review; do not invent revision identifiers. Actual reported model may differ from requested alias and is rejected until explicitly approved. Send model=jev-auto to existing /v1/chat/completions with existing client credentials. Existing Routetok credentials/dashboard/transport remain authoritative; no Hermes dependency or second forwarding server. Normal explicit models are unchanged.

Full text request envelope (up to 24000 bytes) is shared with TypeSafe after persistent operator authorization. No truncation or automatic summary. Disable request-content retention using ROUTETOK_RETAIN_REQUEST_CONTENT=0. x-routetok-local-only:true prevents classification and dispatch. This is not yet a tenant-enforced data policy.

Classifier POST uses fixed HTTPS endpoint, bounded timeout/response, cancellation, no redirects and no retries. Response validates answer types/IDs/distributions, model alias and token usage. Usage is validated but not yet integrated into billing. Returned family maps to approved candidates using existing router admission. Selected physical model is dispatched once, with fallback/stripping disabled. Classification failure returns 503 without downstream generation. Tool history, tools, strict structured output, multimodal and non-Chat protocols are intentionally rejected on jev-auto; existing explicit model routes continue supporting them.

## Evidence and merge gates

Synthetic contract test only; no Jev API access, no measured routing savings/quality. Typecheck passes. Full suite: 217 passed, 1 failed. The failure is integration/proxy.test.ts expecting opencode-real-client/1.2.3; independently reproduced on untouched base ec8c580. Do not label the suite green.

DRAFT: still needs real Jev-to-proxy HTTP integration fixture, independent capability enforcement (existing explicit routing permits unknown/incompatible metadata), measured family outcomes/quality lower bounds, evaluation harness and baseline comparisons, atomic classifier+generation budgets, usage reconciliation, dashboard decision records and error history, virtual-model discovery, alias contract test, session affinity, structured-output compatibility and held-out release gates. Current ordinary Routetok stream deadline behavior remains unchanged; do not claim an absolute end-to-end deadline. This draft proves the native hook and typed adapter, not completion of the larger product requirement.

Before rollout: freeze thresholds on calibration data, evaluate separate source/session holdout, compare fixed cheap/strong and static policies against Jev using objective output checks. Score abstentions as lost coverage; report success intervals, slice regressions, total cost including classifier, p50/p95 latency, and selective risk. Start shadow then limited active canary with rollback; no production activation until evidence exists.
