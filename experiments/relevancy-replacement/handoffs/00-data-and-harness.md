# Handoff 00 — Data + label mapping + eval harness (foundation)

Repo: `~/code/cortex`, branch `experiment/relevancy-replacement` (already exists, already checked out — commit on it, do NOT create a new branch, do NOT push). Read `experiments/relevancy-replacement/00-cortex-contract.md` and `01-decisions-mapping-metrics.md` FIRST — they are the spec. **Do NOT touch any Cortex `src/` code** (read-only). All new code goes under `experiments/relevancy-replacement/`.

Follow repo conventions: Node ≥22 ESM `.mjs`, zero runtime deps where feasible (built-in `node:sqlite`); for dataset download/ML you MAY use Python (this is experiment tooling, not Cortex runtime) — put a `requirements.txt` under the experiment dir and use a venv `experiments/relevancy-replacement/.venv` (gitignore it). Journal every decision + result to `experiments/relevancy-replacement/` and commit as you go.

## Deliverables

### 1. Extract the Cortex past-validation eval set
From `data/cortex.db` (read-only; do NOT write to it). Rows: `SELECT ... FROM calls WHERE purpose='relevance_judgment' AND status='succeeded' AND prompt LIKE '%Product title:%'` (verified: ~4,584 rows). For each, parse from `prompt` with these exact patterns (confirmed working): query = regex `Search query:\s*(.+)`, title = `Product title:\s*(.+)`; grade from `output` = `"grade"\s*:\s*(\d)`. Join to `attempts` (latest attempt per call) for `latency_ms`, `provider_id`, `model`. Write `experiments/relevancy-replacement/data/cortex_validations.jsonl` — one object per line: `{query, title, cortex_grade:int, provider, model, latency_ms}`. Drop rows that don't parse (log how many). This file is EVAL-only and its grades are what we AUDIT (not ground truth).

### 2. Download the public datasets
- **Amazon ESCI, English, small (TRAIN).** Use the official `amazon-science/esci-data` product/examples (small variant, `product_locale='us'`). Produce `data/esci_train.jsonl` with `{query, title, esci_label, grade}` where grade applies the mapping E→3,S→2,C→1,I→0 (from journal 01). Also carve a held-out `data/esci_test.jsonl` (query-disjoint split — no query in both train and test) for arms fine-tuned on ESCI.
- **WANDS (EVAL).** From the `wayfair/WANDS` dataset (query, product title, label ∈ {Exact,Partial,Irrelevant}). Produce `data/wands_eval.jsonl` with `{query, title, wands_label, grade}` applying Exact→3,Partial→2,Irrelevant→0.
- If a source is unreachable, STOP and report the exact URL/error — do NOT fabricate or sample-generate data.

### 3. The label mapping module
`experiments/relevancy-replacement/src/labels.mjs` (or `.py` if the harness is Python — pick ONE language for the harness and be consistent). It must **import/read Cortex's `RELEVANCE_SCALE` from `../../../src/relevance.mjs`** (or read that file and parse the const) — never hardcode the four values. Export the ESCI and WANDS → grade maps from journal 01. A unit test asserts the mapping covers every source label and every target is in `RELEVANCE_SCALE`.

### 4. The eval harness
`experiments/relevancy-replacement/src/evaluate.*` — given an arm's predicted grades and a dataset's gold grades (and, separately, Cortex's grades), compute, per (arm, dataset):
- **QWK** (headline) with a **bootstrap 95% CI** (e.g. 1000 resamples).
- exact accuracy, ±1 accuracy, MAE.
- **NDCG** — reuse Cortex's ranking metric by importing `src/vendor/retail-search-metrics.mjs` (do not re-implement; do not edit it).
- **Speed:** median + p95 wall-clock latency per pair and **peak RSS memory**, measured on this machine (the harness times each arm's own inference; arms report their own timings, harness aggregates).
Output a machine-readable `results/<arm>__<dataset>.json` per run and never overwrite silently (include a timestamp field — but remember `Date.now()` is fine in a normal Node/Python script here; only the Workflow engine forbids it).

### 5. A stub arm to prove the harness end-to-end
Implement Arm A's slot as a trivial constant predictor (always grade 2) ONLY to smoke-test the harness wires up (real BM25 is a later handoff). Run it on `cortex_validations.jsonl` and produce a `results/stub__cortex_validations.json`. This proves extraction + mapping + metrics + output all work before we invest in real arms.

## What NOT to do
- No edits to Cortex `src/`, `data/cortex.db`, `.env.local`, or sibling repos.
- Do not build Arms A–D for real (later handoffs) beyond the stub in step 5.
- Do not push the branch. Do not fabricate data.

## Acceptance criteria (paste evidence)
1. `data/cortex_validations.jsonl` exists, line count reported (~4,584), 3 sample lines shown, and a count of dropped/unparseable rows.
2. `data/esci_train.jsonl`, `data/esci_test.jsonl` (query-disjoint — prove no query overlap), `data/wands_eval.jsonl` exist with counts + 2 samples each; grade distributions printed.
3. Label mapping unit test passes and demonstrably reads `RELEVANCE_SCALE` from Cortex source (show the import/read line).
4. Harness runs the stub arm on the Cortex set and emits `results/stub__cortex_validations.json` containing QWK+CI, accuracy, ±1, MAE, NDCG, and latency/memory fields (the stub's numbers will be poor — that's fine; we're proving plumbing).
5. Repo test command still green; `git status` clean except intended new files under `experiments/relevancy-replacement/` (+ gitignored `.venv`, `data/` large files — decide: commit the jsonl if <~20MB, else gitignore and journal how to regenerate). Journal a `02-data-and-harness.md` entry with counts, decisions, and any dataset-loading surprises.

## Report back
Dataset counts + grade distributions, the mapping-reads-Cortex proof, the stub result JSON contents, files added, test output, and anything ambiguous (esp. the WANDS Partial→2 choice, or ESCI split details) for the main agent to check before real arms are built.
