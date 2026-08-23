# Handoff 03 — Arm C: bge-reranker-v2-m3 fine-tuned on ESCI

Repo `~/code/cortex`, branch `experiment/relevancy-replacement` (checked out; commit, no push). Read journals 00–04 first. Never touch Cortex `src/`, `data/cortex.db`, `.env.local`, sibling repos. All new code under `experiments/relevancy-replacement/`. Reuse the harness (`src/evaluate.mjs`) and label module. Python is fine here (this is training tooling, not Cortex runtime); use the existing `.venv` + `requirements.txt`.

## Goal
Fine-tune **BAAI/bge-reranker-v2-m3** (a cross-encoder reranker) on Amazon ESCI to predict Cortex's 0–3 grade from (query, title) only, then evaluate it on all three eval sets with the shared harness. This is the first learned contender — the hypothesis is that a model that LEARNS the target labels clears the construct/calibration ceiling the prompted arms hit (journal 03: prompted llama3.2:3b was ~1 grade stricter than ESCI, QWK ~0.29 on ESCI).

## Approach
- Hardware: Apple M5, MPS. Use PyTorch (MPS backend) via `sentence-transformers` CrossEncoder or `FlagEmbedding`, whichever fine-tunes bge-reranker-v2-m3 most directly. Model input = `(query, title)`; output = a 0–3 grade.
- Framing: train a **4-way ordinal/classification head** (grades 0/1/2/3) OR regression-then-round — pick one, justify it, and be consistent. Loss appropriate to the choice (cross-entropy for classification; MSE/ordinal for regression).
- Train on `data/esci_train.jsonl` (grades already mapped). **Scope for time on one machine:** use a stratified subset if the full 419k is too slow (e.g. 40–80k pairs, seed=42, balanced across grades) — record the exact train size, epochs, batch size, LR, and wall-clock. Hold out from ESCI-**train** for early-stopping; NEVER touch the eval sets during training.
- Save the fine-tuned model under `experiments/relevancy-replacement/models/bge-esci/` (gitignore the weights; journal how to reproduce).

## Arm wrapper + eval
- `arms/bge_reranker.mjs` or `.py`: loads the fine-tuned model, predicts a 0–3 grade per (query,title), reports its own latency (warm/cold) + peak RSS.
- Run on the SAME seeded eval samples the other arms used: `cortex_validations` (or its 1500 sample — use whichever the other arms' committed results used, so it's comparable), `esci_eval_sample` (3000), `wands_eval_sample` (3000). Produce `results/bge_reranker__{...}.json` via the harness (QWK+CI, acc, ±1, MAE, NDCG, latency, RSS).
- **Fix the harness reporting gap while here:** the ollama results show `parse_failure_rate`/`latency`/`note` as null — make the harness/arms actually populate latency (median/p95 warm+cold) and any failure rate in the result JSON. (bge has no parse failures, but latency must be real.)

## Honesty
If bge-reranker won't fine-tune on this machine (dependency/MPS/memory blocker), STOP and report the exact blocker — do NOT fabricate results or silently fall back to the base (un-fine-tuned) model without saying so. A base-model zero-shot number is acceptable ONLY if clearly labeled "base, not fine-tuned" alongside the blocker.

## Acceptance criteria
1. Training ran (or an honest blocker reported): train size/epochs/hyperparams/wall-clock in the journal.
2. `results/bge_reranker__{cortex,esci,wands}.json` exist with real QWK+CI, acc, ±1, MAE, NDCG, and REAL latency/RSS (not null).
3. No eval-set leakage into training (state the split).
4. `npm test` still green; committed to the branch; journal `06-arm-c-bge.md` with hyperparams, the numbers, and an honest one-paragraph read vs Arms A/B (did learning the labels actually lift QWK on ESCI/WANDS?).

## Report back
Arm C QWK±CI on all 3 sets vs Arm A/B; training setup (size/epochs/time); whether fine-tuning cleared the prompted-LLM ceiling; latency/RSS; any blocker; files added; commit SHA.
