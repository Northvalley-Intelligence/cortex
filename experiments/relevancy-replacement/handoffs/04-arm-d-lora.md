# Handoff 04 — Arm D: Llama-3.2-3B LoRA (mlx_lm) on ESCI, label-token logit read

Repo `~/code/cortex`, branch `experiment/relevancy-replacement` (checked out; commit, no push). Read journals 00–06. Arm C (bge fine-tuned) is the current winner (ESCI QWK 0.360 / WANDS 0.299, ~28ms/pair). Never touch Cortex `src/`, `data/cortex.db`, `.env.local`, sibling repos. All new code under `experiments/relevancy-replacement/`.

## Goal
Fine-tune **Llama-3.2-3B** with **LoRA via `mlx_lm.lora`** (MLX, per the project's hardware spec) on ESCI to grade (query,title) → 0–3, and at inference **read the label-token logits** — constrain to the tokens for "0"/"1"/"2"/"3" and take argmax of their logits; do NOT free-generate and parse text. Question: does a fine-tuned generative model beat the fine-tuned cross-encoder (Arm C)?

## WORKFLOW (important — long training)
Do NOT try to run the whole thing synchronously and then abandon it to a watcher (three prior workers did this). Instead:
1. Build everything: the mlx_lm LoRA training data (ESCI train → the prompt/label format mlx_lm expects), the training config/command, and the arm wrapper `arms/mlx_lora.mjs` (+ `scripts/mlx_infer.py`) that loads base+adapter and does the **label-token logit read** (batch, timed per pair like the other arms).
2. LAUNCH training in the background (`mlx_lm.lora ...`) writing to `logs/mlx_train.log`, print the PID and the exact eval command to run afterward, commit your code + a journal `07-arm-d-lora.md` (setup + how to run), and REPORT. The main agent will monitor training to completion and run the eval. That's the division of labor — you set it up and kick it off; don't babysit.
3. Verify the logit-read wrapper works on a TINY smoke set (5 pairs) before launching the full train, so we know the eval path is sound.

## Specifics
- Base: `Llama-3.2-3B` (or `-Instruct`); use an MLX-compatible copy (mlx-community) — say which.
- LoRA: sensible rank/layers/iters for ESCI on an M5 (document them); train on the same 36k ESCI subset Arm C used (or a documented subset) — NEVER touch the eval sets.
- Inference: single forward pass per (query,title) prompt, read logits at the final position for the four label tokens, argmax → grade. Handle tokenizer specifics (the label may be one token or need a leading space — verify on the smoke set).
- Eval on the SAME seeded samples: `cortex_validations_sample.jsonl`, `esci_eval_sample.jsonl`, `wands_eval_sample.jsonl`, via `scripts/run_arm.mjs mlx_lora.mjs <dataset>` → `results/mlx_lora__*.json` (QWK+CI, acc, ±1, MAE, NDCG, real latency/RSS).

## Honesty
If mlx_lm LoRA won't run on this machine (dependency/memory), STOP and report the exact blocker — do not fabricate or silently swap methods.

## Acceptance criteria
1. Logit-read wrapper smoke-tested on 5 pairs (show the 5 grades) BEFORE full train.
2. Training launched in background (PID + log path reported) OR an honest blocker.
3. Code + journal 07 committed; `npm test` green; the exact eval command documented.
4. (Main agent will run the eval + validate + compare to Arm C/Cortex.)

## Report back
The LoRA setup (base model, rank, iters, train size), the smoke-test grades, the training PID + log path + eval command, any blocker, files added, commit SHA. Do NOT wait on training — set it up, launch it, report, and finish.
