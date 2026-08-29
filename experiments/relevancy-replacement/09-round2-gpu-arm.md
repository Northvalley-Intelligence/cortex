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

## STATUS — BLOCKED at submission (namespace profile gate)

Everything is built, validated, and staged; the ConfigMaps exist on the cluster and the
manifest is schema-valid (`kubectl apply --dry-run=client` passes). `kubectl apply` of the
Job is **denied by NRP's admission webhook**:

> admission webhook "job.nrp-nautilus.io" denied the request: TO RESOLVE THE ISSUE:
> Please ask your namespace admin add **description, institution, publications and
> software** at https://nrp.ai/namespaces

This is a **namespace-profile requirement**, not a defect in the job. The worker has
namespace-scoped admin (can create jobs/configmaps/pvc) but **cannot patch the `Namespace`
object** (`kubectl auth can-i patch namespaces` → **no**; it is cluster-scoped), so the
fields cannot be set from `kubectl`. They are filled by the namespace admin on the NRP web
portal. → **Ferosh action** (see `waiting_on`). Once the profile is completed, the single
`kubectl apply` above launches the run with no further changes.

## Results — 8B (and 14B if run) beside the Round-1 table

Held-out QWK (independent labels). **PENDING** — fills in when the job runs.

| arm | ESCI QWK | WANDS QWK | ESCI acc | WANDS acc | parse fails | notes |
|---|---|---|---|---|---|---|
| BM25 (A, R1) | 0.222 | 0.155 | 0.401 | 0.377 | — | lexical floor |
| **llama3.2:3b prompted (B, R1)** | 0.288 | 0.244 | 0.317 | 0.310 | 7 / 5 | the 3B baseline this arm scales up |
| bge fine-tuned (C, R1) | 0.360 | 0.299 | 0.517 | 0.473 | — | in-domain + latency winner |
| LoRA llama-3.2-3B (D, R1) | 0.353 | 0.486 | 0.483 | 0.603 | — | out-of-domain winner |
| **Qwen2.5-7B prompted (R2, GPU)** | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | family confound vs B |
| Qwen2.5-14B prompted (R2, opt.) | — | — | — | — | — | only if 7B moves the ceiling |

### Honest read — TO BE WRITTEN when numbers land
- Did the bigger prompted model **break** the ~0.3–0.5 ceiling, or just nudge it? The
  reference bar is **Arm B** (same method, smaller model): a large jump over 0.288/0.244
  argues "model size," a small one argues "the task is hard regardless of size."
- **Where it lost / will be logged:** parse-failure count (recorded, never coerced),
  generation wall-time + pairs/sec on the A6000 vs Arm B's ~1–5 s/pair on Metal, and any
  Round-1 arm it does **not** beat (esp. the fine-tuned C/D, which a *prompted* judge may
  still trail even at 7–14B — that would itself be the finding).
- Family confound (Qwen vs Llama) stays flagged until the Llama-3.1-8B re-run.
