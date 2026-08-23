# Journal 08 — FINAL: four arms vs Cortex (all held-out, main-agent-run + validated)

## Headline table (QWK = ordinal-agreement headline; independent-label sets)

| arm | ESCI QWK | WANDS QWK | ESCI acc | WANDS acc | latency/pair | RSS |
|---|---|---|---|---|---|---|
| BM25 (A) | 0.222 | 0.155 | 0.401 | 0.377 | ~0 (lexical) | tiny |
| **Cortex now** = llama3.2:3b (B) | 0.288 | 0.244 | 0.317 | 0.310 | ~1–5 s | ~5–6 GB |
| **bge fine-tuned (C)** | **0.360** | 0.299 | 0.517 | 0.473 | **~28 ms** | ~1 GB |
| **LoRA llama-3.2-3B (D)** | 0.353 | **0.486** | 0.483 | 0.603 | ~0.5–0.9 s | ~4 GB |

(cortex-validation set omitted as an accuracy measure — it's 92% llama3.2:3b, so
"agreement" there is reproduction, not accuracy: B=0.889 repro, C=0.305, D=0.524.)

## Verdict
BOTH fine-tunes beat Cortex's current on-device judge on accuracy, on both
independent datasets. The two fine-tunes split:
- **bge (C):** ties the LoRA on ESCI (0.360 vs 0.353) and is ~20–30× FASTER
  (28 ms vs ~0.5–0.9 s/pair) and ~4× lighter. The all-around winner for
  in-domain + latency.
- **LoRA (D):** clearly better OUT-OF-DOMAIN generalization — WANDS 0.486 vs
  bge 0.299 (validated: a 120-pair re-run reproduced 0.448). A generative LLM's
  broad pretraining transfers to furniture queries where the cross-encoder
  overfit ESCI. Cost: ~20–30× slower, heavier.

So: "more accurate AND faster than Cortex, on this machine" = YES, decisively,
via **bge (Arm C)** — same-or-better accuracy than Cortex, ~200× faster than
Cortex-local. If cross-domain robustness is the priority, the LoRA wins accuracy
at a latency cost.

## Where each arm LOST (honest)
- BM25 (A): lost everywhere on accuracy — lexical overlap ≠ intent. The floor.
- Cortex-local (B): lost to both fine-tunes on every independent metric; also
  the slowest on-device (its full rubric prompt → seconds/pair). Its only
  "win," the 0.889 cortex-set number, is self-reproduction, not accuracy.
- bge (C): LOST to the LoRA on WANDS out-of-domain (0.299 vs 0.486) — it
  generalizes worse beyond ESCI's domain.
- LoRA (D): LOST to bge on speed (~20–30×) and memory, and tied-not-beat on
  ESCI. Its win is generalization, not raw in-domain accuracy.
- All arms: absolute QWK stays modest (~0.3–0.5). Pointwise relevance grading
  is hard; these are real improvements over Cortex, not a solved problem.

## Caveats
- WANDS>ESCI numbers within an arm reflect WANDS being a coarser 3-class
  (0/2/3, no grade-1) = easier label space; compare arms WITHIN a dataset,
  never across.
- Latency methods differ (bge batch=1 serial; B concurrency-4; D serial
  logit-read) — even normalized, the ordering (bge << LoRA << Cortex) holds.
- Cortex's shipped DEFAULT is cloud-first (gemini); a cloud judge would likely
  beat all on-device arms on accuracy but violates "no API, on this machine."
