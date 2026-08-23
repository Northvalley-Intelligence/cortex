# Journal 07 — Arm D setup: Llama-3.2-3B LoRA (mlx_lm), label-token logit read

Handoff `handoffs/04-arm-d-lora.md`. Repo `~/code/cortex`, branch
`experiment/relevancy-replacement` (existing checkout, no push). No Cortex
`src/` code touched. Following the handoff's explicit workflow after three
prior workers failed by babysitting long training synchronously: build +
smoke-test + LAUNCH IN BACKGROUND + report. Not waiting on training here.

## mlx_lm availability (no blocker)

`mlx-lm` was NOT already in `requirements.txt` / `.venv`. Installed cleanly
(`pip install mlx-lm` into the experiment's existing `.venv`, Python 3.14,
arm64): `mlx-0.32.1 mlx-lm-0.31.3 mlx-metal-0.32.1`. `python3 -m mlx_lm.lora
--help` and a 12-iteration training smoke run both worked first try — no
dependency or memory blocker. Machine: Apple Silicon (`arm64`), 16 GB RAM,
226 GB free disk. `mlx-lm` added to `requirements.txt`.

## Base model

`mlx-community/Llama-3.2-3B-Instruct-4bit` (4-bit quantized, ~1.9 GB on
disk). Chosen over the bf16/8bit mlx-community variants because this machine
has only 16 GB total RAM — LoRA training with `--num-layers 16` peaked at
**5.5 GB** in the benchmark run (comfortable headroom), vs. an fp16 3B model
(~6-7 GB weights alone) leaving much less margin once activations/optimizer
state are added. QLoRA-style (LoRA adapters in fp32 on top of a 4-bit frozen
base) is `mlx_lm`'s standard, well-supported path.

## Label-token verification (before writing any code)

Confirmed directly against the real tokenizer before designing the prompt:
- `tokenizer.encode("0"/"1"/"2"/"3", add_special_tokens=False)` → single
  tokens **15, 16, 17, 18** respectively (no leading space — a leading space
  variant `" 0"` etc. splits into 2 tokens: `[220, 15]`).
- Rendering `[user, assistant(content="2")]` through
  `apply_chat_template` and diffing against the prompt-only render shows the
  assistant turn's tokens are exactly `[<digit_token>, <eot_token>]` — i.e.
  the chat template's prompt ends `...assistant<|end_header_id|>\n\n` with
  **no trailing space**, so the very next-token position after the rendered
  prompt is unambiguously the label digit. This is why inference can read
  logits at the LAST position of the prompt with no offset guesswork.

## Prompt (not Cortex's `buildJudgePrompt`)

Arm B (`ollama_prompt.mjs`) reuses Cortex's `buildJudgePrompt`/
`buildJudgeSystemPrompt`, which instruct the model to emit a JSON object
with a `reason` field — correct for free-generation, wrong for a
logit-read arm (there is no free generation to constrain). Arm D uses a new,
minimal prompt (`src/mlxPrompt.mjs`) that still **imports `RELEVANCE_SCALE`
from `src/relevance.mjs`** (never re-typed) and asks for a bare digit:

```
Grade how well the product matches the search query. Output ONLY a single digit: 0, 1, 2, 3.

0 = Irrelevant - does not match the search intent at all
1 = Marginal - same broad category but does not satisfy the intent
2 = Relevant - satisfies the intent but is not an ideal match
3 = Perfect - exactly what the searcher intended

Search query: {query}
Product title: {title}

Grade:
```

`scripts/prepare_mlx_lora_data.mjs` renders this (via `src/mlxPrompt.mjs`)
into `{"prompt":..., "completion":"<digit>"}` records for `mlx_lm`'s
`CompletionsDataset`, and ALSO writes the raw template (with
`__QUERY__`/`__TITLE__` placeholders) to
`data/mlx_lora_data/prompt_template.txt` — `scripts/mlx_infer.py` reads that
same file at inference time, so train-time and inference-time prompts are
byte-identical without duplicating the scale text in Python.

## Training data — reused, not re-sampled

Reuses Arm C's already-verified-leak-free balanced ESCI subset directly:
`data/bge_train_subset.jsonl` (36,000 rows, ESCI-native TRAIN split, balanced
10k/grade) → `data/mlx_lora_data/train.jsonl`, and
`data/bge_dev_subset.jsonl` (4,000 rows) → `valid.jsonl`. Never touches
`esci_test.jsonl` / any `*_eval_sample.jsonl` / `cortex_validations*`. Using
the identical rows Arm C trained on keeps the Arm C vs Arm D comparison a
comparison of METHOD (cross-encoder classifier vs. generative LoRA
logit-read), not of training data.

## Smoke test (BEFORE launching full training — acceptance criterion 1)

Ran `arms/mlx_lora.mjs` against the first 5 rows of `data/esci_eval_sample.jsonl`
with **no adapter** (base model — the adapter didn't exist yet; the arm
transparently falls back to the base model and reports `adapter_used:false`
via `getExtra()` so this is never confused with a trained-arm result):

| query | title (truncated) | gold | pred | latency_ms | cold |
|---|---|---|---|---|---|
| drip drop | Liquid I.V. Hydration Multiplier - Acai Berry... | 2 | **2** | 249 | true |
| royal purple 15w40 diesel oil synthetic | Royal Purple Duralec Super 15W-40... | 2 | 3 | 149 | false |
| air buds | Samsung Galaxy Buds Plus, True Wireless Earbuds... | 3 | 2 | 145 | false |
| diabetic testing kit without blood | AncestryDNA: Genetic Ethnicity Test... | 0 | 2 | 145 | false |
| avengers animated tv series | The Avengers: Volume One - Heroes Assemble!... | 3 | **3** | 145 | false |

3/5 exact even on the UNTRAINED base model (reasonable for an instruct model
given a semantically clear prompt) — proves the whole plumbing (chat-template
rendering, forward pass, label-token-id lookup via the tokenizer rather than
hardcoded ids, argmax, latency timing, RSS reporting, the Node↔Python
subprocess contract) works end to end before spending hours on training.
First pair's raw label logits (0,1,2,3): `[24.52, 24.75, 27.19, 26.36]` —
sane, well-separated floats, not NaN/garbage.

## LoRA hyperparameters (benchmarked before choosing, not guessed)

Benchmarked 12-iteration runs at `--num-layers 8` (0.7 it/sec, 4.3 GB peak)
and `--num-layers 16` (0.47 it/sec, 5.5 GB peak) to pick a real-run size that
finishes in hours, not days, on this M-series/16GB machine:

| param | value | why |
|---|---|---|
| base model | `mlx-community/Llama-3.2-3B-Instruct-4bit` | fits 16GB RAM with headroom |
| fine-tune-type | `lora` | handoff spec |
| rank | 8 (mlx_lm default `lora_parameters`) | untouched — no evidence a bigger rank was needed for a 4-way label task |
| num-layers | 16 (mlx_lm default) | benchmarked 5.5GB peak mem, safe |
| batch-size | 4 | benchmarked, safe |
| iters | 9000 | = 36,000 train rows / batch 4 = **exactly 1 epoch** |
| learning-rate | 1e-5 | benchmark showed fast loss drop (12.5→0.5 val loss in 12 iters on a tiny slice), not so high it looked unstable |
| mask-prompt | on | loss computed ONLY on the completion digit + eos token, not the instruction text |
| max-seq-length | 256 | prompt is ~110-260 tokens depending on title length; margin |
| steps-per-report | 50 | log cadence |
| steps-per-eval / val-batches | 500 / 25 (100 dev rows) | periodic val-loss signal without paying for the full 4k dev set every eval (would have ~10x'd wall time) |
| save-every | 1000 | checkpoints every ~35 min at benchmarked speed; `adapters.safetensors` (live/latest) updated at each checkpoint, so the arm can be evaluated on a partial checkpoint if ever needed |
| seed | 42 | project convention |

At the benchmarked ~0.47 it/sec, 9000 iters was estimated at ~5.3 hours.
**Real-run correction:** the actual training-data rows are longer/more
variable than the 12-iter benchmark slice — Iter 50's report showed
**0.283 it/sec**, revising the estimate to **~8.8 hours**. Caffeinate was
re-armed accordingly (see below) once this was observed.

## LAUNCHED — background training (do not babysit)

```
caffeinate -i -t 21600 &   # PID 93770 — initial 6h assertion (based on the benchmark estimate)
caffeinate -i -t 43200 &   # PID 94627 — RE-ARMED to 12h after Iter 50 showed real speed is slower (~8.8h estimate); both assertions can coexist safely
nohup .venv/bin/python3 -m mlx_lm lora \
  --model mlx-community/Llama-3.2-3B-Instruct-4bit \
  --train --data data/mlx_lora_data --fine-tune-type lora --mask-prompt \
  --num-layers 16 --batch-size 4 --iters 9000 --learning-rate 1e-5 \
  --steps-per-report 50 --steps-per-eval 500 --val-batches 25 --save-every 1000 \
  --max-seq-length 256 --adapter-path models/llama32-3b-lora-esci --seed 42 \
  > logs/mlx_train.log 2>&1 &
```

- **Training PID: 93771** (parent Python process; check with `ps -p 93771`).
- **Log: `experiments/relevancy-replacement/logs/mlx_train.log`** (gitignored,
  like the existing bge train logs).
- Confirmed alive past iter 1 (`Iter 1: Val loss 12.248, Val took 15.688s`),
  `models/llama32-3b-lora-esci/adapter_config.json` written, no
  Error/Traceback in the log as of this journal.
- **Do NOT run another `mlx_lm.lora --train` or any other GPU-heavy job on
  this machine concurrently** — 16 GB RAM, no headroom for two MLX
  processes.

## Eval command (run once training finishes / whenever a checkpoint is wanted)

```
cd experiments/relevancy-replacement
node scripts/run_arm.mjs mlx_lora.mjs cortex_validations_sample.jsonl
node scripts/run_arm.mjs mlx_lora.mjs esci_eval_sample.jsonl
node scripts/run_arm.mjs mlx_lora.mjs wands_eval_sample.jsonl
```

`arms/mlx_lora.mjs` auto-detects `models/llama32-3b-lora-esci/adapters.safetensors`
and uses it when present (falls back to the base model, `adapter_used:false`,
if run before training reaches its first `--save-every` checkpoint at iter
1000 — check `getExtra().adapter_used` / `results/*.json`'s `extra.adapter_used`
field to confirm which was scored). Results land in
`results/mlx_lora__<dataset>.json`, same schema as every other arm (QWK+CI,
accuracy, ±1, MAE, NDCG, latency, RSS).

## Honesty check

No blocker. mlx_lm LoRA ran on this machine on the first real attempt, after
the tokenizer/logit-read mechanics were verified by hand (not assumed) and
the smoke test proved the end-to-end wrapper before any training iteration
was spent. If training crashes or produces a degenerate adapter (e.g. loss
NaN, or the model collapses to always predicting one digit), that will show
up honestly in `logs/mlx_train.log` and in the eval results — not
silently patched over.

## Files added

- `src/mlxPrompt.mjs` — shared prompt template, imports `RELEVANCE_SCALE`
- `scripts/prepare_mlx_lora_data.mjs` — builds `data/mlx_lora_data/{train,valid}.jsonl` + `prompt_template.txt` + `meta.json` from the Arm C balanced ESCI subset
- `scripts/mlx_infer.py` — batch logit-read inference subprocess driver
- `arms/mlx_lora.mjs` — the arm wrapper (`ARM_NAME = "mlx_lora"`)
- `requirements.txt` — added `mlx-lm`
- `.gitignore` — added `data/.mlx_tmp/`, `data/mlx_lora_data/*.jsonl` (large, regeneratable; `prompt_template.txt`/`meta.json` are small and kept tracked)
- (gitignored, regeneratable) `models/llama32-3b-lora-esci/` (adapter weights + checkpoints), `logs/mlx_train.log`, `data/mlx_lora_data/*.jsonl`

## Reproduce from scratch

```bash
cd experiments/relevancy-replacement
source .venv/bin/activate   # or use .venv/bin/python3 directly
pip install -r requirements.txt   # now includes mlx-lm
node scripts/prepare_mlx_lora_data.mjs
python3 -m mlx_lm lora --model mlx-community/Llama-3.2-3B-Instruct-4bit \
  --train --data data/mlx_lora_data --fine-tune-type lora --mask-prompt \
  --num-layers 16 --batch-size 4 --iters 9000 --learning-rate 1e-5 \
  --steps-per-report 50 --steps-per-eval 500 --val-batches 25 --save-every 1000 \
  --max-seq-length 256 --adapter-path models/llama32-3b-lora-esci --seed 42
node scripts/run_arm.mjs mlx_lora.mjs esci_eval_sample.jsonl
node scripts/run_arm.mjs mlx_lora.mjs wands_eval_sample.jsonl
node scripts/run_arm.mjs mlx_lora.mjs cortex_validations_sample.jsonl
```

## Next (main agent)

Monitor `logs/mlx_train.log` / PID 93771 to completion (~8.8h estimate from
launch based on Iter 50's real observed rate, revised up from the initial
~5.3h benchmark estimate — re-arm caffeinate again if it's still running
past the 12h mark), then run the three eval commands above, compare Arm D's
QWK/speed/
RSS against Arm C (bge fine-tuned: ESCI QWK 0.360, WANDS QWK 0.299,
~28 ms/pair, ~1.0 GB RSS) and Cortex-local (Arm B), and report which arm
wins — including an honest report if Arm D loses to Arm C, per the
experiment's stated build order.
