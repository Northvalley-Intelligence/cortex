# Journal 03 — Provider-mix correction + a circularity finding (main-agent review of H00)

Foundation (H00, commit 7cda033) VALIDATED by the main agent: 4,576 Cortex
validations parsed (12 dropped, no grade), ESCI split verified query-disjoint,
WANDS loaded, mapping proven to import `RELEVANCE_SCALE` from Cortex source,
harness (QWK+bootstrap CI, acc/±1/MAE/NDCG, latency/RSS) works, stub proves
plumbing (accuracy 0.4456 == 2039/4576 plurality, QWK 0 — arithmetic checks).

## Correction to journal 01 (verified first-hand)

Journal 01 assumed the Cortex past-validation grades were "mostly
gemini-2.5-flash (cloud)". **Wrong.** Direct query of `data/cortex.db`:

| provider / model | count | share |
|---|---|---|
| local / llama3.2:3b | 4,235 | 92.3% |
| openrouter / poolside-laguna-xs | 271 | 5.9% |
| gemini / gemini-2.5-flash | 82 | 1.8% |

Grade distribution of the set: {0: 241, 1: 1295, 2: 2039, 3: 1001} — skewed
to 1–2, which is why an always-2 stub already scores 44.6% exact / 94.7% ±1.

## The circularity finding (matters for interpreting Arm B)

Arm B is **prompted llama3.2:3b**. 92% of the Cortex-past-validation "gold" was
ALSO produced by llama3.2:3b. So on that set, Arm-B "agreement with Cortex" is
largely **self-agreement / reproduction**, NOT independent accuracy — a fresh
temp-0 llama3.2:3b will reproduce its own cached grades. This is a finding, not
a defect, but it changes what each dataset can tell us:

- **Cortex-past-validation set** → measures REPRODUCTION / self-consistency
  (no independent gold labels exist there; only Cortex's own grades). Report
  Arm-B numbers on it as reproduction, flagged with the 92% provenance. Still
  useful: it shows whether any arm can match Cortex's *shipped behaviour*.
- **ESCI-test and WANDS** → carry the real ACCURACY verdict: every arm
  (including Cortex-local, run live) is scored against independent dataset
  labels. This is where "more accurate than Cortex" is actually decided.
- **Blind disagreement dump** is most meaningful on ESCI/WANDS, where an
  independent label exists to adjudicate a machine-vs-Cortex disagreement.

Decision: keep all three datasets, but the headline "beats Cortex on accuracy"
claim is judged on ESCI-test + WANDS only; Cortex-set results are labelled
"reproduction" throughout. Ferosh's framing — "Cortex's labels are what we're
auditing, not ground truth" — is exactly right and this makes it operational.

## Still-open item for Ferosh (unchanged)

WANDS Partial→2 (62.8% of WANDS rows). Proceeding with →2; one-line flip if he
reads Partial as category-only (→1).
