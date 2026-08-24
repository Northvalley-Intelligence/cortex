# Relevancy Replacement — CPU vs GPU Battle, Round 1

An honest, reproducible experiment: how well can a **laptop** grade e-commerce search
relevance on a 0–3 scale (0 Irrelevant · 1 Marginal · 2 Relevant · 3 Perfect), and when
is it worth reaching for the GPU? This is the first problem in the **CPU vs GPU Battle**
series — start easy and CPU-friendly, then bring in the GPU and deep learning, with a
scorecard that reports the losses as well as the wins.

## The four arms

| Arm | Approach | Where it runs |
|---|---|---|
| **A — BM25** | classical lexical baseline | CPU, instant |
| **B — Prompted LLM** | `llama3.2:3b` via Ollama, the relevance service's on-device judge | CPU, seconds/pair |
| **C — bge-reranker** | cross-encoder fine-tuned on ESCI | GPU to train, ~28 ms/pair to run |
| **D — LoRA** | `Llama-3.2-3B` LoRA, label-token logit read | GPU, ~0.5–0.9 s/pair |

## Headline results (held-out, Quadratic Weighted Kappa)

| Arm | ESCI | WANDS | speed / pair | memory |
|---|---|---|---|---|
| A — BM25 | 0.222 | 0.155 | instant | tiny |
| B — Prompted `llama3.2:3b` | 0.288 | 0.244 | ~1–5 s | ~5–6 GB |
| C — bge-reranker (fine-tuned) | **0.360** | 0.299 | ~28 ms | ~1 GB |
| D — LoRA (logit read) | 0.353 | **0.486** | ~0.5–0.9 s | ~4 GB |

Both fine-tuned arms beat the prompted model on accuracy on both datasets. **bge** wins the
deployment tradeoff (ties/beats on accuracy, ~200× faster); the **LoRA** wins out-of-domain
generalization (WANDS) at a latency cost.

## Read the whole thing honestly

- Absolute QWK stays modest (~0.3–0.5) — pointwise relevance is genuinely hard.
- Compare arms **within a dataset only**: WANDS is a coarser 3-class label space, so its
  numbers are not comparable to ESCI's across arms.
- Accuracy is measured against **independent** human-derived labels (Amazon ESCI, WANDS), not
  against the service's own past judgments — 92% of which were produced by the same local model,
  so agreeing with them measures reproduction, not accuracy (see journal `03`).
- This is an **on-device** contest. The relevance service's shipped default is cloud-first (a
  hosted Gemini model), which was **not** benchmarked and would likely beat every laptop-bound
  arm here. The win is "no API, runs on this machine," not "beats GPT/Gemini."

## Layout

- `00`–`08` — the lab journals, in order (contract, metrics/mapping, data + harness, the
  provider-mix/circularity correction, arms A/B, arm C bge, arm D LoRA, and the final 4-arm verdict).
- `arms/` — one module per arm (`bm25`, `ollama_prompt`, `bge_reranker`, `mlx_lora`, `stub`).
- `scripts/` — `run_arm.mjs` (the harness), data prep, training, and inference scripts.
- `results/` — aggregate metrics per arm × dataset (QWK, accuracy, MAE, nDCG, speed, memory).
- `src/`, `test/` — shared code (BM25, tokenizer, label mapping, evaluation) and its tests.

Raw datasets, trained model weights, and local DBs are `.gitignore`d (see `.gitignore`); the
scripts under `scripts/` regenerate them from the public ESCI and WANDS sources.

Written up in the **CPU vs GPU Battle** series on
[feroshjacob.github.io](https://feroshjacob.github.io/series/cpu-vs-gpu-battle/).
