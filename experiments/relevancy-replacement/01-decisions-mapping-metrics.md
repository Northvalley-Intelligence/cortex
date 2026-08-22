# Journal 01 — Label mapping, metrics, datasets (GATE 2 decisions)

Ferosh approved the contract and said "build the rest," and to fetch the
Cortex past-validations from Cortex's own store (it traces every call).
These are the decisions the build runs on; all are cheap to change (harness
reads them from config), so they're shown for veto, not frozen.

## Datasets (all three now sourced)

1. **Amazon ESCI, English, small — TRAIN.** Public. Labels E/S/C/I.
2. **WANDS — EVAL only.** Public. Labels Exact / Partial / Irrelevant.
3. **Cortex past validations — EVAL only.** Fetched from `data/cortex.db`,
   table `calls` where `purpose='relevance_judgment'` and `status='succeeded'`:
   **4,584 parseable judgments**. Each row's `prompt` embeds
   `Search query: …` / `Product title: …` and `output` embeds
   `{"grade":N,"reason":…}`. Extract (query, title, cortex_grade, provider,
   model, latency via join to `attempts.latency_ms`). NOTE most historical
   grades came from `gemini-2.5-flash` (cloud) — this is Cortex's shipped
   default, and these grades are **what we audit, not ground truth**.

## Label mapping → Cortex `RELEVANCE_SCALE` (import 0–3, never hardcode)

**ESCI:** E→3, S→2, C→1, I→0.
- Rejected: ESCI paper gain weights (1/0.1/0.01/0) — those are NDCG gains, not
  ordinal labels; wrong scale for a 0–3 grade.
- Rejected: C→0 — collapses "complement" into "irrelevant" and throws away the
  exact nuance Cortex's 1 ("same broad category, doesn't satisfy intent")
  captures. A complementary item (e.g. phone case for "phone") is category-
  adjacent, not irrelevant.

**WANDS:** Exact→3, Partial→2, Irrelevant→0 (grade 1 left unpopulated).
- Rejected: Partial→1 — too harsh; WANDS "Partial" = partially satisfies,
  which matches Cortex 2 ("satisfies but not ideal") better than 1. **This is
  the mapping most worth Ferosh's eye** — if he reads WANDS Partial as
  category-only, flip it to 1.
- A 3-level set into 4 levels leaving a gap at 1 is fine; not every grade must
  be populated by every dataset.

## Metrics (fit the 0–3 ordinal graded scale)

- **Headline: Quadratic Weighted Kappa (QWK)** — ordinal agreement penalizing
  by squared distance (a 3-vs-0 miss hurts far more than 3-vs-2). Bootstrap
  95% CI on QWK per arm per dataset.
  - Rejected as headline: plain accuracy — treats a 3→2 slip the same as 3→0,
    wrong for an ordinal scale. Kept as a secondary.
- **Secondary:** exact accuracy, ±1 (off-by-one) accuracy, MAE, and **NDCG**
  (Cortex's own ranking metric, via its vendored retail-search metrics) so
  results are comparable to what Cortex reports.
- **Speed, equal rigor:** wall-clock latency per pair (median + p95) and peak
  process memory (RSS), measured on THIS M5 per arm. Warm and cold separated
  (cold = includes model load), because the contract already showed cold vs
  warm is a 10× gap for llama3.2:3b.

## Blind disagreement dump

For the best arm vs Cortex: every pair where they differ, dumped with query +
title + both grades but **blinded** (columns "grade_A"/"grade_B", not
"correct"/"wrong"), shuffled, so Ferosh judges them without knowing which is
the machine and which is Cortex. Cortex's grade is audited, not assumed right.

## What each arm must satisfy

Input = (query, title) only. Output = an integer grade in `RELEVANCE_SCALE`
(0–3). Arms: A BM25 lexical baseline; B llama3.2:3b prompted via Ollama
(≈ Cortex-local); C bge-reranker-v2-m3 fine-tuned on ESCI; D Llama-3.2-3B LoRA
via mlx_lm.lora on ESCI, reading label-token logits at inference (no
free-generation). Cortex itself is the 5th arm (its historical grades on the
past-validation set; live /v1/relevance on ESCI/WANDS samples).

## Build order (each gated by main-agent validation before the next)

0. Data + mapping + eval harness (this + extraction, one worker). ← dispatched
1. Arm A — BM25.  2. Arm B — Ollama prompt.  3. Arm C — bge fine-tune.
4. Arm D — mlx LoRA + logit read.  5. Run-all + aggregate + blind dump +
final timeline with an honest list of where the new approach LOST.
