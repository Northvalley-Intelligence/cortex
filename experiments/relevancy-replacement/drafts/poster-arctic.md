<!--
================================================================================
ARCTIC / SCD 2026 RESEARCH POSTER — FINAL CONTENT (approved to submit).

Covers the whole "CPU vs GPU Battle — search relevance" project including the
external-datacenter-GPU (Round 2) result. It reports the losses next to the wins,
per this project's contract.

EVERY number below is cited to a repo journal or a results/*.json file, and was
re-verified against those files on finalization (2026-08-31). No number is invented.
Where a number is a rounded/summary figure, the exact source value is given in
parentheses. Sources live at experiments/relevancy-replacement/ on:
  - branch `main` / `experiment/relevancy-replacement`: journals 00-08, README,
    and all Round-1 results/*.json (bm25, ollama_prompt, bge_reranker, mlx_lora).
  - branch `round2-gpu-arm`: journal `09-round2-gpu-arm.md` and
    `results/gpu_prompt_qwen2.5-7b__round2.json` (Round-2 / external GPU).
  (This poster branch carries the poster file; the Round-2 sources are on
   round2-gpu-arm, not yet merged to main.)

REMAINING PRODUCTION STEP (not a content blocker): this is the poster's text +
structure. The uploadable poster is a 36" x 48" designed PDF built from this
content (LaTeX/beamer-poster or a designer pass) — see "Poster file to upload"
in the CMT fields below and Figure 1 in Section 2.4.
================================================================================
-->

# CMT SUBMISSION FIELDS — ARCTIC / SCD 2026 (paste into cmt3.research.microsoft.com/scd2026)

> Reference (fetched 2026-08-29 from https://arctic.gsu.edu/create-a-submission/):
> ARCTIC (Advanced Research Computing Technology, Innovation & Collaboration) hosts
> the "Scientific Computing Day" (SCD) symposium at Georgia State University.
> Poster max size **36" x 48"**. Platform **Microsoft CMT**. **Deadline: Sept 3, 2026.**
> Optional: accepted posters may email PowerPoint slides by **Sept 17** for a
> 5-minute lightning talk. Abstract should emphasize computational methods,
> significant results, and scientific merit/impact (no stated word limit).

| CMT field | Value to enter |
|---|---|
| **Title** | The CPU-vs-GPU Battle for Search Relevance: The ~0.3–0.5 Quality Ceiling Is the Task, Not the Model Size |
| **Principal Investigator (PI)** | Ferosh Jacob (presenter / submitter) |
| **All contributing authors** | Ferosh Jacob; Jiho Noh |
| **Affiliation** | Department of Computer Science, Kennesaw State University |
| **Department** | Computer Science |
| **Primary subject area** | Machine Learning / Natural Language Processing (or nearest CMT menu equivalent) |
| **Secondary subject area (optional)** | Information Retrieval / Search |
| **Abstract** | Paste the Abstract section below (≈200 words). |
| **Poster file to upload** | TODO — the 36"x48" designed poster PDF built from this content (LaTeX/beamer-poster or designer pass). Not yet produced; this markdown is the approved content source. |

*Note: PI vs. author — Ferosh Jacob is entered as PI + presenter/submitter and Jiho
Noh as co-author. If CMT requires a PI distinct from the author list, keep Ferosh Jacob
as PI.*

---

# The CPU-vs-GPU Battle for Search Relevance: Where the ~0.3–0.5 Quality Ceiling Is the *Task*, Not the *Model Size*
### An honest, reproducible benchmark of six relevance-grading judges across CPU, a laptop GPU (Apple Metal), and a datacenter GPU (NRP/Nautilus)

---

## Authors & Affiliation

- **Ferosh Jacob and Jiho Noh** — Department of Computer Science, Kennesaw State University.
- **Presenter / PI:** Ferosh Jacob.
- **Contact:** ferosh@northvalleyintel.com

---

## Abstract
*(≈200 words; ARCTIC asks the abstract to emphasize computational methods,
significant results, and scientific merit/impact.)*

E-commerce search engines must grade how well each product matches a query on an
ordinal 0–3 scale (0 Irrelevant · 1 Marginal · 2 Relevant · 3 Perfect). We ask an
honest, reproducible question: **how good a relevance judge can run entirely on a
laptop, and when is a GPU actually worth it?** Using one shared evaluation harness
and identical held-out test sets (Amazon **ESCI** and Wayfair **WANDS**, 3,000
pairs each, independent human labels), we benchmark six judges spanning three
hardware tiers — a **CPU** lexical baseline (BM25); three **laptop-GPU** arms on
Apple Metal (a prompted `llama3.2:3b`, a fine-tuned `bge-reranker-v2-m3`
cross-encoder, and a `Llama-3.2-3B` LoRA read via label-token logits); and a
**datacenter-GPU** arm (`Qwen2.5-7B-Instruct` prompted via vLLM on an NRP/Nautilus
GPU). The headline metric is **Quadratic Weighted Kappa (QWK)**, with bootstrap 95%
CIs. **Key finding:** every judge lands in a narrow **~0.3–0.5 QWK band**. Scaling a
prompted judge 3B→7B on a real GPU lifted QWK (+0.073 ESCI, +0.110 WANDS) enough to
*match* the fine-tuned cross-encoder in-domain with **no training** — but did **not**
break the band, and the best out-of-domain result (the 3B LoRA, WANDS 0.486) still
stands. **The ceiling is the task, not the model size.** We report every loss beside
every win.

---

## 1. Background & Problem

- **The task.** A production relevance service (internal codename *Cortex*) grades
  each `(query, product title)` pair on the 0–3 `RELEVANCE_SCALE`
  (0 Irrelevant / 1 Marginal / 2 Relevant / 3 Perfect). Its shipped judge is an
  LLM-as-judge, one model call per pair. Source of the scale and I/O contract:
  journal `00-cortex-contract.md` (reads `src/relevance.mjs:24-29`).
- **The question (computational-methods framing).** Pointwise relevance grading is
  an ordinal classification problem. *How well can it be done on a laptop, and where
  does reaching for the GPU — first the laptop's own integrated GPU, then a
  datacenter card — actually pay off in accuracy?* (README; journal `00`.)
- **Why it's hard / why it matters.** Relevance is intent, not word overlap; a "2 vs
  1" boundary is genuinely subjective even for humans. A judge that runs on-device
  ("no API, on this machine") is cheaper and private, but must be shown to *beat the
  local judge it would replace*, on independent labels — not merely to reproduce it.

---

## 2. Methods

### 2.1 One shared evaluation harness (the thing that makes arms comparable)
Every arm runs through the identical pipeline so the six are directly comparable
(journal `02-data-and-harness.md`):
- **Inputs:** `(query, product title)` only — the exact signal the production judge
  uses (journal `00`).
- **Label mapping** imports `RELEVANCE_SCALE` from the service's own source
  (never re-typed): ESCI E→3, S→2, C→1, I→0; WANDS Exact→3, Partial→2, Irrelevant→0
  (grade 1 deliberately unpopulated) (`01-decisions-mapping-metrics.md`, `src/labels.mjs`).
- **Harness:** `scripts/run_arm.mjs` → `arm.predict(pairs)` → `src/evaluate.mjs`.
- **Metric (headline): Quadratic Weighted Kappa (QWK)** — ordinal agreement that
  penalizes a 3-vs-0 miss far more than a 3-vs-2 miss — with a **1,000-resample
  bootstrap 95% CI** (deterministic seed). Secondary: exact accuracy, off-by-one
  (±1) accuracy, MAE, and NDCG (the service's own vendored ranking metric).
  Speed (median/p95 latency per pair, cold vs warm) and peak RSS measured per arm.
  (`01`, `02`.)

### 2.2 Datasets & the honest-labels rule (a core scientific-merit point)
- **ESCI** (Amazon, English small; native query-disjoint train/test split, verified
  0 query overlap) and **WANDS** (Wayfair furniture; eval-only) carry the **accuracy**
  verdict — independent human-derived labels (`02`).
- **A circularity guard.** A third set (the service's 4,576 past validations) is used
  ONLY as a *reproduction* check, never as accuracy: **92.3%** of those grades were
  produced by the same local `llama3.2:3b` (`03-provider-mix-correction.md`), so
  "agreeing" with them measures reproduction, not accuracy. Every accuracy claim in
  this poster is on ESCI/WANDS only.

### 2.3 The six judges (arms), by hardware tier

| Tier | Arm | Approach | Where it runs |
|---|---|---|---|
| **CPU** | **A — BM25** | classical lexical baseline (the floor) | CPU, instant |
| **Laptop GPU** (Apple Metal) | **B — Prompted `llama3.2:3b`** | LLM-as-judge via Ollama = the shipped on-device judge | Metal, seconds/pair |
| **Laptop GPU** (Apple Metal / MPS) | **C — bge-reranker-v2-m3** | cross-encoder fine-tuned on ESCI, 4-class head, argmax (PyTorch MPS) | Metal, ~28 ms/pair |
| **Laptop GPU** (Apple Metal / MLX) | **D — Llama-3.2-3B LoRA** | LoRA fine-tune, read label-token logits (no free generation) | Metal, ~0.4–0.9 s/pair |
| **Datacenter GPU** (NRP/Nautilus) | **R2 — Prompted `Qwen2.5-7B-Instruct`** | SAME prompt+parser+QWK as Arm B, bigger model, via vLLM | NVIDIA GPU, batched |

- **Arms A–D (Round 1)** run on an Apple M-series laptop (16 GB RAM). The "GPU"
  there is the integrated Apple GPU (Metal) — no hand-written CUDA/Metal kernels; the
  frameworks (Ollama, PyTorch-MPS, Apple MLX) handle device dispatch (README).
- **Round-2 arm (R2)** is the controlled scale-up: it changes **only the model and
  the hardware** and holds the prompt, parser, QWK code, and eval sets **byte-for-byte
  identical** to Arm B (verified line-for-line; system-prompt sha256 matched on laptop
  and in-cluster), so any QWK movement is attributable to model scale, not pipeline
  drift (`09-round2-gpu-arm.md`).
  - Preferred model was **Llama-3.1-8B-Instruct** (same family as Arm B → clean 3B→8B
    size isolation), but it is **gated** and no `HF_TOKEN` was available, so the open
    **Qwen2.5-7B-Instruct** was used instead (**stated confound: this changes model
    *family* as well as size**).
  - Infra: 1× NVIDIA GPU on NRP/Nautilus via `vLLM chat`, namespace
    `kennesaw-state-fjacob`; scheduled onto a 24–48 GB card pool (ran on an
    RTX-3090/A10-class node); model load 103.8 s, then greedy generation. Parse
    failures are recorded as **failures and excluded from QWK — never coerced to 0**
    (contract rule). (`09`.)

### 2.4 Figure 1 — architecture diagram (poster visual centerpiece — TO BE PRODUCED)
> **Status:** the poster's designed centerpiece diagram is a production TODO — it is
> specified below for the designer/LaTeX pass, not drawn here (no diagram is fabricated).
> An existing project figure (`images/cpu-vs-gpu-battle-part-2.png`, the CPU-vs-GPU
> battle motif from Part 2 of the article series) can serve as an interim/visual-motif
> asset, but the poster ideally wants the pipeline diagram described here.
>
> **What the diagram must show:** ONE evaluation pipeline fanning across THREE
> hardware tiers, all converging on the same QWK scorecard. Left to right:
>
> 1. **Inputs (shared):** `(query, product title)` pairs drawn from **ESCI-test**,
>    **WANDS**, (and the reproduction-only Cortex set, greyed) → a **label-mapping**
>    box that imports `RELEVANCE_SCALE` (0–3) from the production service's own source.
> 2. **Shared harness (single box all arms pass through):** `run_arm.mjs →
>    arm.predict() → evaluate.mjs` computing **QWK + bootstrap 95% CI**, plus
>    accuracy/±1/MAE/NDCG and speed/RSS. Emphasize visually that *this box is
>    identical for every arm* — that's what makes them comparable.
> 3. **Three hardware lanes branching out of the harness:**
>    - **CPU lane** (grey): Arm A — BM25 lexical (Node, no GPU).
>    - **Laptop-GPU lane** (one badge: "Apple M-series GPU / Metal"): Arm B — Ollama
>      `llama3.2:3b` prompted; Arm C — bge cross-encoder, **fine-tuned** (PyTorch-MPS);
>      Arm D — Llama-3.2-3B **LoRA**, logit-read (Apple MLX). Show C and D with a small
>      "trained on ESCI" tag; B with a "prompted, no training" tag.
>    - **Datacenter-GPU lane** (badge: "NRP / Nautilus · NVIDIA GPU · vLLM"): Round-2
>      `Qwen2.5-7B` prompted — with a callout that ONLY the model+hardware changed vs
>      Arm B (same prompt/parser/QWK).
> 4. **Convergence:** all lanes feed one **QWK scorecard** panel (the results table
>    below) with a horizontal **~0.3–0.5 "task ceiling" band** drawn across it, and
>    every arm's ESCI & WANDS dots landing inside that band — the single visual that
>    carries the paper's thesis. Mark the two fine-tunes and the 7B as the top cluster,
>    and annotate the LoRA's WANDS 0.486 as the lone reach toward the top of the band.
> 5. Small hardware icons per lane (laptop chip vs datacenter rack) to make the
>    "CPU vs laptop-GPU vs datacenter-GPU" story legible at poster distance.

---

## 3. Results

### 3.1 Headline — QWK on the independent held-out sets (95% CI), all six arms
*(Every cell cited to a `results/*.json`; QWK rounded to 3 dp, exact value from file
in the source note. Compare arms WITHIN a dataset only — see limitation L2.)*

| Tier | Arm | **ESCI QWK** (95% CI) | **WANDS QWK** (95% CI) | ESCI acc | WANDS acc | Source |
|---|---|---|---|---|---|---|
| CPU | A — BM25 | 0.222 (0.183–0.256) | 0.155 (0.128–0.184) | 0.401 | 0.377 | `bm25__{esci,wands}_eval_sample.json` |
| Laptop GPU | B — Prompted `llama3.2:3b` (= shipped on-device judge) | 0.288 (0.258–0.320) | 0.244 (0.217–0.271) | 0.317 | 0.310 | `ollama_prompt__{esci,wands}_eval_sample.json` |
| Laptop GPU | C — bge cross-encoder (fine-tuned) | **0.360** (0.325–0.391) | 0.299 (0.262–0.334) | 0.517 | 0.473 | `bge_reranker__{esci,wands}_eval_sample.json` |
| Laptop GPU | D — Llama-3.2-3B LoRA (logit-read) | 0.353 (0.320–0.385) | **0.486** (0.453–0.517) | 0.483 | 0.603 | `mlx_lora__{esci,wands}_eval_sample.json` |
| **Datacenter GPU** | **R2 — Prompted `Qwen2.5-7B` (GPU)** | **0.361** (0.333–0.389) | 0.354 (0.326–0.382) | 0.343 | 0.332 | `gpu_prompt_qwen2.5-7b__round2.json` (branch `round2-gpu-arm`) |

*Exact QWK values: A 0.22204 / 0.15478 · B 0.28823 / 0.24383 · C 0.35996 / 0.29928 ·
D 0.35275 / 0.48581 · R2 0.36095 / 0.35367.*
*Test sets: 3,000 pairs each. Arm B parsed 2,993 (ESCI) / 2,989 (WANDS) — 7 / 11 parse
failures excluded, never coerced (per the results files). R2 parsed 2,997 (ESCI) /
3,000 (WANDS) — 3 / 0 parse failures. (`02`, `08-final-comparison.md`, `09`; results files.)*

### 3.2 The Round-2 result, read against Round 1 (the scientific payload)
- **Scaling the prompted judge 3B→7B on a datacenter GPU lifted QWK — but stayed in
  the band.** vs Arm B (same method, 3B): **+0.073 on ESCI** (0.288→0.361) and
  **+0.110 on WANDS** (0.244→0.354). With **no fine-tuning**, the prompted 7B:
  - **ties the fine-tuned cross-encoder on ESCI** (0.361 vs 0.360), and
  - **beats it on WANDS out-of-domain** (0.354 vs 0.299)
  — a genuinely useful "no training required" result. (`09`.)
- **But it did NOT break the ceiling.** The 7B lands at ~0.35 on both sets — squarely
  inside the same **~0.3–0.5 QWK band** every Round-1 arm occupied. **The ceiling is
  the TASK, not the model size.** (`09`.)

### 3.3 Speed & memory tradeoffs (why the laptop still wins deployment)
| Arm | Latency / pair (warm median; p95) | Peak memory | Notes | Source |
|---|---|---|---|---|
| A — BM25 | ~instant (<0.01 ms) | ~0.11 GB RSS | lexical, CPU only | `bm25__*` |
| B — Prompted `llama3.2:3b` | ~5.4 s ESCI / ~5.2 s WANDS (at concurrency-4); effective ~0.73–0.77 pairs/s | Ollama holds ~5–6 GB (separate process; harness RSS n/a) | slowest on-device | `ollama_prompt__*` (`08`) |
| C — bge cross-encoder | **27.9 ms** ESCI / 29.6 ms WANDS (p95 ~38–40 ms) | **~1.06 GB** RSS | ~2 s model load; **0 parse failures** (argmax) | `bge_reranker__*` |
| D — Llama-3.2-3B LoRA | 873 ms ESCI / 360 ms WANDS (p95 3.2 s / 1.4 s) | ~2.67 GB RSS | 4-bit base + LoRA; logit-read, 0 parse failures | `mlx_lora__*` |
| R2 — Qwen2.5-7B (GPU) | batched **23.5 pairs/s** ESCI / **32.8 pairs/s** WANDS | needs ≥24 GB datacenter GPU; **103.8 s** model load | high throughput but not on-device | `gpu_prompt_qwen2.5-7b__round2.json` |

- **Deployment winner: bge (Arm C).** Matches or beats the on-device judge on accuracy
  while running **~1–2 orders of magnitude faster** (~28 ms vs seconds/pair) in **~5×
  less memory**, and it never malforms output (no free-text to parse). (`06-arm-c-bge.md`, `08`.)
- **Out-of-domain winner: the LoRA (Arm D).** WANDS 0.486 (validated; a 120-pair re-run
  reproduced ~0.448) — a generative model's broad pretraining transfers to furniture
  queries the cross-encoder overfit past. Cost: ~20–30× slower than bge. (`07-arm-d-lora.md`, `08`.)

### 3.4 The main conclusion
Two fine-tunes and a 2.3×-bigger prompted judge all cluster in the **~0.3–0.5 QWK
band**. Scaling helped *within* the band (enough to match a fine-tuned model with no
training) but did not break *out* of it, and the single best out-of-domain number —
the 3B LoRA's **WANDS 0.486** — **still stands, untouched by the 7B**. On this evidence
the answer to "is the ceiling the model or the task?" is **the task.** A 14B/70B
prompted judge was therefore **deliberately not run** — the trend showed diminishing
returns inside the band, so spending more GPU was not justified (`09`).

---

## 4. Where each arm LOST (the contract: report losses, not just wins)
- **A — BM25:** lost everywhere on accuracy — lexical overlap ≠ intent. It is the
  floor, kept for reference, not a contender (`04-arms-ab.md`).
- **B — Prompted `llama3.2:3b` (the shipped judge):** lost to both fine-tunes on every
  independent metric and is the slowest on-device arm (seconds/pair). Its only high
  number — agreement on the service's own past grades — is *self-reproduction*, not
  accuracy (`08`).
- **C — bge cross-encoder:** LOST out-of-domain — WANDS 0.299 vs the LoRA's 0.486; a
  specialist whose edge thins off its ESCI home turf. Also carries a train/test gap
  (dev QWK peaked 0.471 vs held-out ESCI 0.360 — the honest number is the held-out
  one) (`06`).
- **D — LoRA:** LOST on speed/memory (~20–30× slower than bge) and only *tied* bge
  in-domain on ESCI (0.353 vs 0.360). Its win is generalization, not raw in-domain
  accuracy (`08`).
- **R2 — Qwen2.5-7B (GPU), the sharpest Round-2 losses:**
  - **Loses to the LoRA out-of-domain: WANDS 0.354 vs 0.486** — the bigger prompted
    judge did NOT catch the best Round-1 result; that number stands (`09`).
  - **Loses on EXACT accuracy to both fine-tunes** (0.343/0.332 vs bge 0.517/0.473 and
    LoRA 0.483/0.603). Its QWK is respectable only because its misses are ordinally
    *close* (±1 accuracy 0.79/0.87); it rarely nails the exact grade.
  - **It hugs the middle / under-predicts grade 3** (predicts grade 3 for only
    479/2,997 ESCI and 148/3,000 WANDS pairs) — it agrees on *rank* far better than on
    *label* (`09`, prediction distribution in the results file).
  - **Deployment cost:** needs a ≥24 GB datacenter GPU and a ~104 s load — for a
    shipping on-device judge, bge still wins the efficiency tradeoff by a wide margin.

---

## 5. Limitations & honest caveats
- **L1 — Absolute QWK is modest.** Everything sits at ~0.3–0.5. These are real
  improvements over the baseline, **not a solved problem**; pointwise relevance
  grading is genuinely hard (`08`, `09`).
- **L2 — Compare arms WITHIN a dataset only.** WANDS is a coarser 3-class label space
  (0/2/3, no grade 1), so a WANDS number and an ESCI number are not on the same ruler
  (`01`, `08`).
- **L3 — Independent labels = accuracy; the service's own history = reproduction.**
  92.3% of the service's past grades came from the same local model, so agreeing with
  them measures reproduction, not accuracy — excluded from every accuracy claim
  (`03`, `08`).
- **L4 — This is an ON-DEVICE contest.** The service's shipped *default* is cloud-first
  (a hosted Gemini model), which was **not** benchmarked and would very likely beat
  every laptop-bound arm. The claim is "no API, runs on this machine, and it beats the
  local judge" — not "beats frontier cloud models" (README, `08`).
- **L5 — Round-2 family confound (open).** The fallback used **Qwen2.5-7B** (open),
  not the preferred **Llama-3.1-8B** (gated, no `HF_TOKEN`), so the +0.073/+0.110 over
  Arm B mixes model *family* with *size*. A clean same-family 3B→8B ablation is still
  open (needs an `HF_TOKEN`) — though the ceiling held for a strong 7B, so it is
  unlikely to change the headline (`09`).
- **L6 — Latency methodologies differ across arms** (bge batch=1 serial; B
  concurrency-4; D serial logit-read; R2 vLLM batched). Even normalized, the ordering
  (bge ≪ LoRA ≪ prompted) holds (`06`, `08`).
- **L7 — 14B/70B not run** — a deliberate choice, not an omission: the 3B→7B trend
  already showed diminishing returns inside the band (`09`).

---

## 6. Conclusion & impact
For an on-device search-relevance judge, **fine-tuning a small specialist (bge
cross-encoder) is the best accuracy-per-millisecond** — better than the shipped judge,
~1–2 orders of magnitude faster, ~5× lighter. **A bigger *prompted* model on a
datacenter GPU buys in-domain parity with no training**, but not a breakthrough:
the **~0.3–0.5 QWK ceiling is a property of the task**, and the best out-of-domain
result comes from a **3B LoRA on a laptop**, not from more GPU. The practical takeaway
for practitioners: *reach for the GPU to train a small specialist or to skip training
via a mid-size prompted model — but don't expect raw model size to break the quality
ceiling on pointwise relevance.*

---

## Reproducibility
All arms share one harness (`scripts/run_arm.mjs`, `src/evaluate.mjs`); label mapping
imports the production `RELEVANCE_SCALE`; datasets are the public ESCI and WANDS
sources regenerated by scripts under `scripts/`. Round-2 held prompt/parser/QWK
byte-identical to Round-1 Arm B and ran on NRP/Nautilus via vLLM. Journals `00`–`09`
document every decision, including the discarded first Arm-B run and the provider-mix
correction. Repo: `experiments/relevancy-replacement/` (Round-2 sources on branch
`round2-gpu-arm`).

<!--
PRODUCTION CHECKLIST (content is final; these are layout/design steps):
  [ ] Build the 36"x48" poster PDF from this content (LaTeX/beamer-poster or designer).
  [ ] Produce Figure 1 (Section 2.4) as the visual centerpiece; interim motif asset
      available at images/cpu-vs-gpu-battle-part-2.png.
  [ ] Upload that PDF to CMT (cmt3.research.microsoft.com/scd2026) with the fields at top.
  [ ] Optional: email PowerPoint slides by Sept 17 if the poster is accepted (lightning talk).
-->
