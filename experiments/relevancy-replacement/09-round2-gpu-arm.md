# Journal 09 — Round 2: the "bigger-GPU arm" (does model SIZE break the QWK ceiling?)

Branch: `round2-gpu-arm`. Round 1 ended with a modest absolute ceiling — every arm
landed at ~0.3–0.5 QWK on the independent held-out sets, prompted `llama3.2:3b` (Arm B)
lowest of the learned/prompted arms at ESCI 0.288 / WANDS 0.244. The open question that
closed Journal 08: **is that ceiling the TASK (pointwise relevance is just hard) or the
MODEL (3B on a laptop is just small)?** Round 2 isolates it by running a **bigger prompted
judge on a real datacenter GPU** with the method held constant, so any QWK movement is
attributable to model scale, not to a changed pipeline.

## What is held CONSTANT vs Round-1 Arm B (this is the whole point)

Directly comparable numbers require changing exactly one thing (model + hardware) and
nothing else. Verified line-for-line against the Round-1 sources:

| Held constant | Round-1 source | Round-2 reuse |
|---|---|---|
| Judge **system prompt** | `buildJudgeSystemPrompt(null)` = Cortex frame + `DEFAULT_JUDGE_RUBRIC` (`src/relevance.mjs`) | dumped byte-for-byte to `round2_system_prompt.txt`; **sha256 `99a0e99…2cb51b`** matches on the laptop and inside the ConfigMap |
| Per-pair **user prompt** | `buildJudgePrompt({query, product:{title}})` | `build_user_prompt()` in `scripts/gpu_judge.py`, exact port |
| **Parser** | `parseJudgment()` — strip `<think>`/fences, first-`{`→last-`}`, integer grade ∈ {0,1,2,3}, else THROW | `parse_judgment()`, exact port; a parse failure is recorded as a **FAILURE and excluded from QWK — never coerced to 0** (contract rule, Journal 00) |
| **Eval sets** | `esci_eval_sample.jsonl` / `wands_eval_sample.jsonl` (3000 rows each) — the exact files Round-1 arms scored on (`results/ollama_prompt__*_eval_sample.json`) | same files, gzipped into a ConfigMap |
| **QWK** | `quadraticWeightedKappa()` minGrade=0 maxGrade=3, n=4 (`src/evaluate.mjs`) | `quadratic_weighted_kappa()`, exact port — **cross-checked to 1e-9** against the JS on 3 seeded arrays before shipping |

Only the **model and hardware** change. (vLLM `chat()` applies the model's own instruct
chat template — the same shape as Ollama applying llama3.2's template for Arm B, so the
prompt-delivery mechanism is matched too.)

## Model + why

- **Preferred: Llama-3.1-8B-Instruct** — same family as Arm B's Llama-3.2-3B, so 3B→8B
  isolates SIZE cleanly. It is **gated** on HuggingFace and **no `HF_TOKEN` was available
  in the worker environment**, so it could not be pulled.
- **Used (fallback): `Qwen/Qwen2.5-7B-Instruct`** — open/ungated, a strong ~7B instruct
  judge. **CONFOUND, stated honestly:** this changes model **FAMILY** as well as size vs
  Arm B (Llama). So a QWK lift here is "a bigger, different-family prompted model," not a
  pure size ablation. To get the clean size isolation, re-run with Llama-3.1-8B once an
  `HF_TOKEN` is in the env (`waiting_on` for Ferosh).
- **Staged, not yet run: Qwen2.5-14B-Instruct** — only worth spending if 7B→ shows the
  ceiling actually moving (per the plan: 8B first, 14B only if promising/ambiguous, and no
  jump to 70B/A100 unless the trend is clear).

## Infra (NRP / Nautilus)

- **Job** `k8s/round2-gpu-judge-8b.yaml`: 1× **NVIDIA RTX A6000 (48 GB)** via
  `nodeAffinity` on `nvidia.com/gpu.product=NVIDIA-RTX-A6000`. **Non-preemptible** (no
  `opportunistic` priorityClass), **non-quota-gated** card, within the 2-GPU
  non-preemptible limit. `restartPolicy: Never`, `backoffLimit: 0`,
  `activeDeadlineSeconds: 7200` (never idles → no ban risk), `ttlSecondsAfterFinished: 48h`.
- **Image** `vllm/vllm-openai:latest`; entrypoint overridden to `python3 /code/gpu_judge.py`.
- **Data + code staged as ConfigMaps** (repo is private, so no clone): `round2-data`
  (gzipped eval jsonl, ~262 KB) and `round2-code` (`gpu_judge.py` + the exact system prompt).
- **Results** → stdout between `RESULTS_JSON_BEGIN/END` markers, collected via `kubectl logs`.
- Namespace `kennesaw-state-fjacob`.

Reproduce:
```
kubectl -n kennesaw-state-fjacob create configmap round2-data \
  --from-file=esci_eval_sample.jsonl.gz=… --from-file=wands_eval_sample.jsonl.gz=…
kubectl -n kennesaw-state-fjacob create configmap round2-code \
  --from-file=gpu_judge.py=scripts/gpu_judge.py --from-file=round2_system_prompt.txt=…
kubectl apply -f k8s/round2-gpu-judge-8b.yaml
kubectl -n kennesaw-state-fjacob logs -f job/round2-gpu-judge-8b
```

## STATUS — RAN (job `round2-gpu-judge-8b` Succeeded)

The namespace-profile gate (description/institution/publications/software at nrp.ai) was
cleared by Ferosh, then three scheduling fixes got the pod onto a GPU:
1. **NRP resource-ratio policy** — limit must be ≤ 1.2× request for cpu/mem/ephemeral. Set
   requests == limits (cpu 3 / mem 20Gi / ephemeral 40Gi).
2. **large-gpu taint** — 48GB cards carry `nautilus.io/hardware: large-gpu`; added the
   toleration (hardware, not preemption — still non-preemptible).
3. **GPU pool too narrow** — every A6000 was allocated (`Insufficient nvidia.com/gpu`).
   Qwen2.5-7B (fp16 ~15GB) fits any ≥24GB card, so the nodeAffinity was widened to a pool of
   non-quota-gated 24–48GB products (RTX-3090/A10/A5000/4090/TITAN-RTX/RTX-6000/L40/L40S/A40/
   A6000; A100/H100/H200/GH200 excluded — quota-gated, custom resource name). It scheduled
   immediately (RTX-3090/A10 alone had dozens of free GPUs) onto `k8s-gen4-05.calit2`.

Run: model load 103.8 s, then greedy generation at **23.5 pairs/s (ESCI)** / **32.8 pairs/s
(WANDS)** — 3000 pairs each in ~2 min per set. Raw results:
`results/gpu_prompt_qwen2.5-7b__round2.json`.

## Results — Qwen2.5-7B prompted, on GPU, beside the Round-1 table

Held-out QWK (independent labels), computed by the identical formula as Round 1.

| arm | ESCI QWK | WANDS QWK | ESCI acc | WANDS acc | parse fails (esci/wands) | notes |
|---|---|---|---|---|---|---|
| BM25 (A, R1) | 0.222 | 0.155 | 0.401 | 0.377 | — | lexical floor |
| **llama3.2:3b prompted (B, R1)** | 0.288 | 0.244 | 0.317 | 0.310 | 7 / 5 | the 3B baseline this arm scales up |
| bge fine-tuned (C, R1) | 0.360 | 0.299 | 0.517 | 0.473 | — | in-domain + latency winner |
| LoRA llama-3.2-3B (D, R1) | 0.353 | **0.486** | 0.483 | 0.603 | — | out-of-domain winner |
| **Qwen2.5-7B prompted (R2, GPU)** | **0.361** | 0.354 | 0.343 | 0.332 | 3 / 0 | this run; family confound vs B |
| Qwen2.5-14B prompted (R2, opt.) | not run | not run | — | — | — | ceiling did not move enough to justify (see below) |

Qwen2.5-7B 95% CI: ESCI [0.333, 0.389], WANDS [0.326, 0.382]. Off-by-one accuracy 0.79
(ESCI) / 0.87 (WANDS); MAE 0.91 / 0.80.

### Honest read — did the bigger prompted model break the ceiling? NO.

**The ceiling is the TASK, not the model size.** A 2.3× bigger, stronger prompted judge
(3B → 7B) landed at **~0.35 QWK on both sets** — squarely inside the same ~0.3–0.5 band
every Round-1 arm occupied. It did not break out of it. Pointwise relevance grading against
independent human labels is genuinely hard, and throwing a bigger prompted model at it does
not change that. So the answer to Round 1's open question is settled on the prompted axis:
size helps *within* the band, but the band itself is the task.

**Where scaling DID help (real, but bounded):** vs Arm B (same method, 3B) QWK rose
+0.073 on ESCI (0.288→0.361) and +0.110 on WANDS (0.244→0.354). With **no fine-tuning**, the
prompted 7B now:
- **ties bge on ESCI** (0.361 vs 0.360) and **beats bge on WANDS** (0.354 vs 0.299) — i.e. a
  prompted model matches a fine-tuned cross-encoder in-domain and generalizes better than it
  out-of-domain, which is a genuinely useful "no training required" result.

**Where it LOST (honest):**
- **Loses to the LoRA (D) out-of-domain on WANDS: 0.354 vs 0.486.** The fine-tuned generative
  arm still clearly wins generalization; the bigger prompted judge did NOT catch it. This is
  the sharpest loss and the clearest sign the ceiling didn't move: the best Round-1 number
  (0.486) still stands untouched.
- **Loses on EXACT accuracy to both fine-tunes:** 0.343/0.332 vs bge 0.517/0.473 and LoRA
  0.483/0.603. Its QWK is respectable only because its errors are ordinally *close*
  (off-by-one ~0.79/0.87) — it rarely nails the exact grade. The prediction distribution
  shows it hugging the middle: it under-predicts grade 3 (479/2997 on ESCI, 148/3000 on
  WANDS) and over-uses 1–2, so it agrees on *rank* far better than on *label*.
- **Deployment cost:** needs a ≥24GB datacenter GPU and a ~104 s model load; throughput is
  high (23–33 pairs/s batched) but bge does ~28 ms/pair on ~1 GB. For a shipping on-device
  judge bge still wins the efficiency tradeoff by a wide margin.
- **Parse failures: 3 on ESCI (recorded as FAILURES, never coerced to 0), 0 on WANDS.** All
  three are the same failure mode — the model emitted literal unescaped `"` inside the JSON
  `reason` string (an inch mark `40"`, or quoting the query `"cream and sugar"`), breaking
  `JSON.parse`. A prompted judge writing free-text reasons occasionally produces invalid JSON;
  Cortex's parser correctly rejects it rather than inventing a grade.

**14B: not run, on purpose.** The plan said go bigger only if 8B moved the ceiling clearly.
It didn't — 7B landed on the same ~0.35 plateau as the 3B fine-tunes, and the 3B→7B trend is
already inside the band with diminishing returns. A 14B (or 70B) prompted judge would very
likely stay in the same band at more cost, so spending it is not justified by this evidence.
The manifest is one `--model` change away if Ferosh wants the datapoint anyway.

**Confound (still open):** the fallback used **Qwen2.5-7B**, not the preferred
Llama-3.1-8B (gated, no `HF_TOKEN`). So the +0.07/+0.11 over Arm B mixes model *family* with
*size*. A clean same-family 3B→8B size ablation needs Llama-3.1-8B — worth one more run if a
token appears, though it is unlikely to change the headline (the ceiling held for a strong 7B).
