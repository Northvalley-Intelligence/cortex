# Journal 02 — Data + label mapping + eval harness (foundation build)

Handoff: `handoffs/00-data-and-harness.md`. Branch `experiment/relevancy-replacement`
(existing checkout, no push). No Cortex `src/` code touched — read-only for
`00-cortex-contract.md`'s I/O schema and `RELEVANCE_SCALE`, read-only for
`data/cortex.db` (opened with `{ readOnly: true }` via `node:sqlite`).

## 1. Cortex past-validation extraction

`scripts/extract_cortex_validations.mjs` reads `data/cortex.db` (`calls` join
latest `attempts` by `MAX(attempt_no)`), parses `prompt`/`output` with the
regexes from the handoff, writes `data/cortex_validations.jsonl`.

- Rows scanned: 4,588. Kept (parsed): **4,576**. Dropped: 12, all
  `no_grade_match` (an `output` that didn't contain a `"grade":N` at all —
  presumably a failed-parse call that still got marked `succeeded` upstream,
  or a differently-shaped output; not investigated further since it's outside
  this handoff's scope and the row count is negligible).
- Grade distribution: `{0: 241, 1: 1295, 2: 2039, 3: 1001}`.

**Surprise worth flagging:** journal 01 said "most historical grades came
from `gemini-2.5-flash` (cloud)". The actual provider/model breakdown in the
extracted set is:

| provider | model | rows | share |
|---|---|---|---|
| local | llama3.2:3b | 4,235 | 92.5% |
| openrouter | poolside/laguna-xs-2.1:free | 267 | 5.8% |
| gemini | gemini-2.5-flash | 74 | 1.6% |

This **overturns** that premise — the Cortex past-validation set is
overwhelmingly on-device `llama3.2:3b` judgments, not cloud gemini. Since
journal 01 frames these grades as "what we audit, not ground truth" either
way, this doesn't block the build, but it changes what "auditing Cortex's
historical grades" actually means (mostly auditing the on-device model, not
the shipped cloud default) — flagging for Ferosh/main-agent review.

## 2. Public datasets

### ESCI (official `amazon-science/esci-data`, git-lfs, fetched via
`media.githubusercontent.com/media/...` since `raw.githubusercontent.com`
only serves the LFS pointer for these paths)

`scripts/download_esci.py`: downloads `shopping_queries_dataset_examples.parquet`
(51MB) and `shopping_queries_dataset_products.parquet` (1.1GB, filtered to
`product_locale=='us'` at read time via pyarrow predicate pushdown), filters
examples to `product_locale=='us' & small_version==1` (the official
"small, English" variant), joins on `(product_id, product_locale)`. 0 rows
lost to a missing title after the join.

- 601,354 rows after filter+join. `esci_label` distribution: E 261,527 /
  S 211,191 / I 101,447 / C 27,189.
- ESCI ships its own `split` column (train/test). **Verified query-disjoint**
  independently in both python (pre-mapping) and node (post-mapping,
  `scripts/apply_label_mappings.mjs`): 20,888 train queries, 8,956 test
  queries, **0 overlap** by both `query_id` and raw `query` text. Used this
  native split directly rather than re-splitting, since it's already the
  property the handoff asked for.
- `scripts/apply_label_mappings.mjs` applies `src/labels.mjs`'s
  `esciLabelToGrade` (E→3, S→2, C→1, I→0) and writes:
  - `data/esci_train.jsonl`: 419,653 rows. Grade distribution:
    `{0: 71116, 1: 19090, 2: 147628, 3: 181819}`.
  - `data/esci_test.jsonl`: 181,701 rows. Grade distribution:
    `{0: 30331, 1: 8099, 2: 63563, 3: 79708}`.

### WANDS (official `wayfair/WANDS`, tab-separated CSVs despite `.csv` extension)

`scripts/download_wands.py`: downloads `query.csv`, `product.csv`, `label.csv`,
joins `label` → `query` → `product` on their id columns.

- 233,448 labeled (query, product) rows. 0 missing after join.
  `wands_label` distribution: Partial 146,633 / Irrelevant 61,201 / Exact 25,614.
- `scripts/apply_label_mappings.mjs` applies `wandsLabelToGrade`
  (Exact→3, Partial→2, Irrelevant→0; grade 1 deliberately unpopulated).
  Output `data/wands_eval.jsonl`: 233,448 rows. Grade distribution:
  `{0: 61201, 2: 146633, 3: 25614}`.
- **Ambiguity flagged per handoff:** Partial→2 (not →1) is journal 01's
  explicit call, on the grounds that WANDS "Partial" = partially satisfies
  intent, closer to Cortex's 2 ("satisfies but not ideal") than 1 ("same
  broad category, doesn't satisfy"). Given Partial is 62.8% of WANDS rows,
  this choice materially shapes the WANDS grade distribution (no reason for
  Ferosh to *not* flip it if he reads WANDS Partial as category-only — it's a
  one-line change in `src/labels.mjs`'s `WANDS_LABEL_MAP` and a rerun of
  `apply_label_mappings.mjs`).

Both datasets came from their official repos on the first attempt; no
unreachable source, nothing fabricated.

## 3. Label mapping module

`src/labels.mjs` imports `RELEVANCE_SCALE` directly:
```js
import { RELEVANCE_SCALE } from "../../../src/relevance.mjs";
```
— resolves to `cortex/src/relevance.mjs:24-29`, the single source the
contract journal names. `VALID_GRADES` is derived (`Object.keys(RELEVANCE_SCALE).map(Number)`),
not re-typed, and every map entry is validated against it at module-load time
via `assertValidGrade` (would throw immediately if `RELEVANCE_SCALE` ever
dropped a grade or changed its keys).

`test/labels.test.mjs` (6 tests, all pass) independently re-reads
`src/relevance.mjs` from disk and asserts every `RELEVANCE_SCALE` value the
module imported appears verbatim in that file — proof the import isn't
silently stale, plus coverage checks (every ESCI/WANDS source label is
mapped, every target is a valid grade) and exact-value checks against journal
01's decisions.

## 4. Eval harness

`src/evaluate.mjs`:
- `quadraticWeightedKappa` (headline) — hand-implemented (no runtime dep),
  verified in `test/evaluate.test.mjs` to give QWK=1 for perfect agreement and
  to penalize far misses more than near misses.
- `bootstrapQwkCI` — 1000 resamples, deterministic mulberry32 PRNG (seed 42)
  so results are reproducible run-to-run without a runtime dependency.
- `exactAccuracy`, `offByOneAccuracy`, `meanAbsoluteError` — straightforward,
  unit-tested with hand-computed expected values.
- `meanNdcg` — groups pairs by `query`, ranks by `pred_grade` descending
  (stable on ties), scores against gold grades as qrels via **Cortex's own
  vendored** `ndcgAtK` from `src/vendor/retail-search-metrics.mjs`
  (imported, not reimplemented, per the contract). Reports the number of
  queries actually scored.
- `speedStats` — median/p95 latency split by `cold` flag, since the contract
  journal measured a 10x cold/warm gap for `llama3.2:3b`.
- `evaluateArm` — the per-(arm,dataset) entry point; emits every field the
  handoff's acceptance criteria list.

`scripts/run_arm.mjs` is the CLI glue: loads an arm module from `arms/`, a
dataset jsonl from `data/`, runs `arm.predict(pairs)`, evaluates, writes
`results/<arm>__<dataset>.json` (never overwrites silently — an existing
result is renamed aside with a `.superseded-<timestamp>.json` suffix first).

## 5. Stub arm — proves the harness end to end

`arms/stub.mjs`: constant predictor, always grade 2. Run against the full
Cortex past-validation set:

```
node scripts/run_arm.mjs stub.mjs cortex_validations.jsonl
```

`results/stub__cortex_validations.json` (4,576 pairs, 402 queries):

```json
{
  "arm": "stub",
  "dataset": "cortex_validations",
  "n_pairs": 4576,
  "qwk": 0,
  "qwk_ci95": { "low": 0, "high": 0, "resamples": 1000 },
  "accuracy": 0.4455856643356643,
  "off_by_one_accuracy": 0.947333916083916,
  "mae": 0.6070804195804196,
  "ndcg": { "mean_ndcg": 0.8622691598133629, "queries": 402 },
  "speed": {
    "warm": { "n": 4575, "median_ms": 0.000041, "p95_ms": 0.000042 },
    "cold": { "n": 1, "median_ms": 0.0005, "p95_ms": 0.0005 }
  },
  "peak_rss_bytes": 59244544
}
```

As expected for a constant predictor: QWK=0 (zero-variance predictions carry
no ordinal agreement signal beyond chance), accuracy ~44.6% (matches grade-2
being the plurality class, 2039/4576=44.6%), off-by-1 ~94.7% (grade 2 is
adjacent to most of the mass), NDCG ~0.86 is an artifact of the constant
prediction preserving input row order rather than any real ranking signal
(worth remembering when real arms are compared — a high NDCG alone doesn't
prove ranking skill). Latency is sub-microsecond since there's no real
computation, which is expected and not meaningful — proves the timing wiring
works, not anything about arm speed.

**This is exactly what the handoff asked the stub to prove: extraction +
mapping + metrics + results-JSON output all work end to end**, before real
arms are built.

## Files added (all under `experiments/relevancy-replacement/`)

- `src/labels.mjs`, `src/evaluate.mjs`
- `arms/stub.mjs`
- `scripts/extract_cortex_validations.mjs`, `scripts/download_esci.py`,
  `scripts/download_wands.py`, `scripts/apply_label_mappings.mjs`,
  `scripts/run_arm.mjs`
- `test/labels.test.mjs`, `test/evaluate.test.mjs`
- `requirements.txt`, `.gitignore`
- `results/stub__cortex_validations.json`
- (gitignored, regeneratable) `.venv/`, `data/raw/*`, `data/*.jsonl`

## Data-commit decision

All `data/*.jsonl` files are **gitignored**, not committed, even though
`data/cortex_validations.jsonl` (724KB) is under the ~20MB bar the handoff
allowed for committing. Rationale: it's extracted from Cortex's live trace
store and embeds real historical (query, product title) pairs — the same
class of content `.env.local`/`data/*.db` are already gitignored to keep out
of git history. `esci_train.jsonl` (73MB), `esci_test.jsonl` (32MB), and
`wands_eval.jsonl` (27MB) are gitignored purely on size. `data/raw/` (1.3GB:
the ESCI parquet files + WANDS CSVs) is gitignored outright.

**To regenerate everything from scratch:**
```bash
cd experiments/relevancy-replacement
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
node scripts/extract_cortex_validations.mjs      # -> data/cortex_validations.jsonl
python3 scripts/download_esci.py                  # -> data/raw/esci_*.parquet, esci_small_us_raw.csv
python3 scripts/download_wands.py                 # -> data/raw/wands_*.csv
node scripts/apply_label_mappings.mjs              # -> data/esci_train.jsonl, esci_test.jsonl, wands_eval.jsonl
node scripts/run_arm.mjs stub.mjs cortex_validations.jsonl   # -> results/stub__cortex_validations.json
```

## Repo test command

`npm test` (repo root, unaffected by this experiment — no `src/` edits):
**111/111 pass.** This experiment's own tests (`node --test
experiments/relevancy-replacement/test/*.test.mjs`, 13 tests) also pass; they
are not part of `npm test`'s glob (`test/*.test.mjs` at repo root only) by
design, since this is experiment tooling, not Cortex runtime.

## Open items for main-agent review before real arms are built

1. **Provider mix surprise** (section 1 above) — the Cortex past-validation
   set is 92.5% on-device `llama3.2:3b`, not majority-cloud `gemini-2.5-flash`
   as journal 01 assumed. Worth re-reading journal 01's framing before Arm B
   (Ollama llama3.2:3b) is built, since it's now clearer that Arm B is being
   compared against a very similar model already dominating the audit set.
2. **WANDS Partial→2 vs →1** (section 2 above) — the single most
   consequential, most subjective mapping call in the whole pipeline (62.8%
   of WANDS rows). Flagged exactly as the handoff asked.
3. **ESCI query-disjoint split** — used ESCI's own native `split` column
   rather than re-deriving one; verified 0 query overlap two independent ways.
   No further action needed unless a different train/test ratio is wanted.
4. 12 Cortex-db rows dropped as unparseable (`no_grade_match`) — not
   investigated beyond confirming the count is negligible (0.26% of 4,588).
