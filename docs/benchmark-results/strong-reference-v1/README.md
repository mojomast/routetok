# Stronger-reference pilot

Frozen commit30cb4f0, six randomly selected MBPP rows excluded from prior development/heldout partitions, references executed before inference. Twelve actual OpenRouter requests, two concurrent, no retries, raw-code strict scoring, 8192 maximum output tokens, curl120s total wall deadline plus subprocess130s guard. No Jev calls. Source hash and full public task manifest committed before requests. Prompt includes first example assertion; all three assertions score output.

Mercury6/6, provider-reported$0.00146265, median2328ms. GPT4.1 6/6,$0.006058, median1276ms. All bills known. No observed stronger-model accuracy gain; GPT4.1 was faster in this small run. This does NOT show Mercury equally capable generally: tiny single-draw sample, public corpus contamination possible, limited tests, no repair/repository/tool tasks. Cases now inspected, not reusable as untouched holdout.

Decision: keep stronger model as optional reference, do not pay classification/escalation overhead by default. Expand toward explicit multi-file repair with application-supplied acceptance tests and separate hidden scoring. Existing single-function benchmark is saturating; more easy samples won't identify reliable routing opportunity. First establish repeated cheap-fail/strong-pass cases on development tasks, then freeze a policy for a fresh evaluation. No routing promotion or production-default changes justified here.

Generated code executes with existing Docker limits, no network/host mounts. Unit references all passed before inference. Full product tests not rerun for this standalone Python-only experiment; script syntax verified and real execution completed successfully.
