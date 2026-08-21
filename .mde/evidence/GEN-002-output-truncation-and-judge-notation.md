# GEN-002 — Output-truncation diagnosis + judge notation fix

Two changes, validated and deployed together in one graceful restart on 2026-07-30.

## Change 1 — output-side truncation is now recorded and diagnosed

**Motivation.** The relevance judge returned `null` grades in an external run. Root cause
(confirmed by probe): the judge was pointed at **qwen3:4b**, a thinking model, at a 200-token
completion budget. The `<think>` block consumed the entire budget before any JSON was emitted,
so Ollama returned HTTP 200 with `done_reason: "length"` and an empty response. Cortex recorded
only a generic parse failure — the operator had to *hypothesize* output truncation rather than
read it.

Probe evidence:
- `llama3.2:3b` @ num_predict=200 → done_reason=stop, 20 tokens, clean `{"grade": 3, ...}`.
- `qwen3:4b` @ num_predict=200 → done_reason=**length**, 200 tokens, empty output, parse FAIL.
- `qwen3:4b` @ num_predict=1200 → done_reason=stop, 983 tokens, clean JSON.

**Fix.** `done_reason` (Ollama) / `finish_reason` (OpenAI-protocol) is captured per attempt and
normalised to `done_reason` + `output_truncated` columns on `attempts`. `trace.diagnose()` adds
a branch: when an attempt is output-truncated, fault is attributed to **caller** (token budget),
confident, with a next-step naming the thinking-model trap — even when the call "succeeded" with
partial output. Output truncation does **not** trigger fallback (another provider would do the
same). Distinct from `truncation_detected`, which is INPUT truncation.

**Schema migration.** Additive + idempotent (`ALTER TABLE ... ADD COLUMN` guarded by
`PRAGMA table_info`). Verified against a copy of the live 1,329-row production DB: both columns
added, all rows preserved, old rows default to `done_reason=null / output_truncated=0`,
idempotent on re-open.

**Tests.** `test/trace-integrity.test.mjs`: output-truncation diagnosed as caller fault (not a
bad model); does-not-trigger-fallback. Fake adapter gains an `outputTruncated` fault shape
mirroring the real qwen3 case. Full suite 85/85.

**Live confirmation.** Post-deploy judgment attempt recorded `done_reason: "stop"`,
`completion_tokens: 28`, `output_truncated: 0` on llama3.2:3b — the clean non-thinking signature.

## Change 2 — judge measurement-notation defect

**Defect (reported by ecommmerce-eval, reproduced independently here on live llama3.2:3b).**
The judge read cosmetic measurement notation in the query as a size/type mismatch:

```
query "1/2-in screw"  vs  "#8 x 1/2 in. Zinc Phillips Flat Head Wood Screw"
  BEFORE -> {"grade": 0, "reason": "Incorrect size unit: 1/2-in instead of 1/2 inch."}
```

The product IS a half-inch screw. The bug was also inconsistent (identical screws graded 3 and
0 in one job) and contaminated exactly the notation-equivalence queries under evaluation.

**Fix.** `JUDGE_SYSTEM_PROMPT` gains a MEASUREMENT NOTATION section (notation is cosmetic, never
lowers a grade, with an equivalence list) and a PRODUCT TYPE section (so the fix is not mere
leniency — a fitting/accessory/set is still graded down), plus two worked examples. Text is
byte-identical to the prompt ecommmerce-eval validated (`/tmp/prompt-final.txt`); scale lines
stay generated from `RELEVANCE_SCALE`.

**Validation.**
- ecommmerce-eval gold set (13 cases): 9/13 → 12/13, all 6 notation cases correct, product-type
  discrimination preserved, determinism restored (8/8 identical across 3 temp-0 re-runs).
- Independent re-validation here (stricter 13-case gold set, 3× temp-0): notation defect
  resolved and **13/13 deterministic**. 3 residual misses are off-by-one *undergrades* on
  relevant items (2 instead of 3) — the ±1 model-capacity noise the handoff documented as
  non-blocking, not the notation bug. No case regressed to the notation-0 failure.

**Live confirmation.** Same reproduction case submitted through the running service post-deploy:
```
  AFTER -> {"grade": 3, "reason": "Half-inch screw; 1/2-in equals 1/2 in."}
```

## Residual / follow-up
- 3B judge retains ±1 boundary noise on some clearly-relevant items (undergrade to 2). Model
  capacity, not prompt. A larger judge model would tighten calibration if wanted later.
- If Cortex's local model is ever pointed at a thinking model (qwen3), the judge's default
  `maxTokens: 120` will output-truncate; the new diagnosis now says so explicitly. Options:
  raise the budget (~1200), disable thinking, or keep a non-thinking judge.
