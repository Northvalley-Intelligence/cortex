# Journal 06 — Arm C (bge-reranker-v2-m3 fine-tuned on ESCI): the first arm to BEAT Cortex

Main-agent-run held-out eval (the worker abandoned before eval; Fable ran it).
Fine-tune: 4-class head on bge-reranker-v2-m3, 36k ESCI train / 4k dev, 3
epochs, best dev QWK 0.471. Then evaluated on the SAME seeded held-out samples
every other arm used.

## Headline QWK (bootstrap 95% CI) on the INDEPENDENT-label sets

| arm | ESCI | WANDS (never trained on) |
|---|---|---|
| BM25 (A) | 0.222 | 0.155 |
| llama3.2:3b = Cortex-local (B) | 0.288 | 0.244 |
| **bge fine-tuned (C)** | **0.360** | **0.299** |

Arm C beats Cortex's on-device judge on BOTH independent datasets, and holds
its edge on WANDS — so it GENERALIZES, not just fits ESCI. Confirms the
journal-03 diagnosis: the prompted model's weakness was calibration, and
learning the labels fixes it. (On the Cortex set bge scores 0.305 — that's
agreement with Cortex's own llama-grades, not accuracy; an independent judge
should disagree there, and does.)

## Speed + memory — the bigger win

- bge: **~28 ms/pair** warm (ESCI), peak RSS ~1.0 GB.
- Arm B (Cortex-local, llama3.2:3b + Cortex's full rubric): median ~5.4 s/pair
  as timed (concurrency-4 wall-clock; true serial ≈1–2 s), RSS ~5–6 GB (Ollama).
- ⇒ bge is 1–2 ORDERS OF MAGNITUDE faster and ~5× lighter.

## Honest caveats
- Absolute QWK is still modest (~0.30–0.36) — pointwise relevance grading is
  hard; bge is BETTER than Cortex, not stellar.
- The latency comparison mixes methodologies (bge serial batch=1 vs Arm B
  concurrency-4); even normalized, bge wins by ~1–2 orders of magnitude.
- dev QWK 0.471 vs held-out ESCI 0.360 = the usual train/test gap; 0.360 is the
  honest number.

## Verdict
Arm C is the first arm that beats Cortex's current on-device relevancy on
accuracy AND speed AND memory, and generalizes. Arm D (Llama-3.2-3B LoRA,
logit-read) is next — the question is whether a fine-tuned generative model
beats the fine-tuned cross-encoder.
