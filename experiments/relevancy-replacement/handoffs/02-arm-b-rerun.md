# Handoff 02 — Arm B (llama3.2:3b) re-run + Cortex-local baseline (clean, synchronous)

Repo `~/code/cortex`, branch `experiment/relevancy-replacement` (checked out; commit, no push, no branch). Read journals 00–04. Arm A is done. `arms/ollama_prompt.mjs` already exists (reuse/fix it). Never touch Cortex `src/`, `data/cortex.db`, `.env.local`, sibling repos.

## CRITICAL execution rule (the last run failed on this)
Run everything **synchronously inside your own turn**. Do NOT spawn a Monitor, do NOT `run_in_background` the arm and exit, do NOT "stand by for notifications." Start each run, wait for it to finish in-process, then commit. You are not done until results exist, are committed, and the journal is written.

## Fixes vs the aborted run
1. **Concurrency:** call Ollama with a worker pool of **4 concurrent requests** (M5 handles it). Verify Ollama keeps `llama3.2:3b` loaded (`keep_alive`); measure and report effective throughput.
2. **Sample the Cortex set:** for Arm B use a **1,500-row stratified sample** of `cortex_validations.jsonl` (seed=42, stratified by cortex_grade), written once to `data/cortex_validations_sample.jsonl` and reused. (Reproduction needs no more; keeps runtime ~10 min at concurrency 4.) ESCI/WANDS use the existing seeded 3k samples.

## Arm B deliverable
Run `arms/ollama_prompt.mjs` (llama3.2:3b via Ollama, temp 0, Cortex's rubric contract, import `RELEVANCE_SCALE`, parse one-line JSON `{"grade":n}`, DON'T coerce parse-fails to 0 — report the rate) on: `cortex_validations_sample.jsonl` (1500), `esci_eval_sample.jsonl` (3000), `wands_eval_sample.jsonl` (3000). Produce `results/ollama_prompt__{cortex_validations,esci_eval_sample,wands_eval_sample}.json` via the harness (QWK+CI, acc, ±1, MAE, NDCG, latency warm/cold, peak RSS). On the cortex result add `"note": "reproduction — this set is 92% llama3.2:3b (journal 03); agreement here is self-consistency, not accuracy"`.

## Cortex-local baseline (the thing to beat on the independent sets)
Score Cortex-local on the SAME `esci_eval_sample` and `wands_eval_sample` (3k each), so ESCI/WANDS have a Cortex number to compare every arm against. Preferred: `POST http://127.0.0.1:7077/v1/relevance` with `CORTEX_PROVIDER_CHAIN=local` set in the SCRIPT's env only (never edit `.env.local`); poll the job to completion. If the running server can't be forced local per-request, fall back to calling Ollama with Cortex's exact prompt as the documented local proxy. Produce `results/cortex_local__esci_eval_sample.json` and `results/cortex_local__wands_eval_sample.json`.

## Acceptance criteria (paste evidence)
1. `data/cortex_validations_sample.jsonl` (1500, seed, grade dist shown).
2. Three `ollama_prompt__*.json` with all metrics; parse-failure rate + warm/cold latency + effective throughput (concurrency) reported; reproduction `note` present on the cortex one.
3. Two `cortex_local__*.json` (or documented proxy).
4. A comparison line per independent dataset (ESCI, WANDS): Arm A QWK vs Arm B QWK vs Cortex-local QWK, with CIs — so overlap/separation is visible.
5. `npm test` green; work committed to the branch; journal `05-arm-b-and-cortex-local.md` with the numbers and an honest note on where Arm B LOST (esp. vs Cortex-local on the independent sets — remember QWK 0.86 on the Cortex set is reproduction, not a win).

## Report back
The QWK±CI table (A / B / Cortex-local × cortex/esci/wands), parse-fail rate, throughput, where Arm B lost, files added, test output, commit SHA.
