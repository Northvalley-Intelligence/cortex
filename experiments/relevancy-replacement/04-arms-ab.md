# Journal 04 — Arm A (BM25) results; Arm B run reset

## Arm A — BM25 lexical baseline: DONE and validated

Thresholds calibrated on ESCI-train only (no eval leakage). Results
(harness, QWK headline + 1000-resample bootstrap CI):

| dataset | QWK (95% CI) | exact acc | ±1 acc | MAE |
|---|---|---|---|---|
| cortex_validations (n=4,576) | **0.414** (0.394–0.435) | 0.356 | 0.804 | 0.858 |
| esci_eval_sample (n=3,000) | **0.222** (0.183–0.256) | 0.401 | 0.749 | 0.952 |
| wands_eval_sample (n=3,000) | **0.155** (0.128–0.184) | 0.377 | 0.711 | 0.960 |

Read: BM25 is a **weak** grader, as expected — lexical token overlap is not
search intent. It does least badly on the Cortex set (whose grades a
title-overlap signal partly tracks) and worst on WANDS (furniture, where
intent ≠ words). This is the honest floor every learned arm must clear.
**Where A loses: everywhere on accuracy** — it is the baseline, not a
contender. Kept for the floor.

## Arm B — reset (why the first run was discarded)

The H01 worker built `arms/ollama_prompt.mjs` and a runner, then abandoned
the run mid-flight: it spawned a self-monitor and left an orphaned background
`node run_ollama_prompt.mjs` chain running unmanaged, never committed, never
journaled, never did the Cortex-local baseline, and never populated the
required reproduction `note`. The one Arm-B result it left (cortex_validations
QWK 0.862) had ambiguous provenance — a "superseded" sibling file plus a
still-writing process — and a suspicious exact ±1 = 1.000, so it was
DISCARDED, not trusted. The main agent stopped the agent + killed the run.

Two real problems to fix on the re-run:
1. **Speed.** Measured ~1.02 s/pair with Cortex's full rubric prompt (not the
   0.3 s of the bare prompt) → the full sets would be ~3 h serial. Fix: run
   Ollama with **concurrency** (M5 handles a few parallel llama3.2:3b calls),
   and **sample the Cortex-validation set to 1,500 stratified** (a reproduction
   check needs no more; matches the 3k eval-sample scale).
2. **Execution discipline.** The re-run must run to completion **synchronously
   within the worker**, commit results + journal, and NOT delegate to a
   monitor and exit.

`arms/ollama_prompt.mjs` code is kept (reused by the re-run). Arm A code +
results committed now; Arm B re-dispatched clean.
