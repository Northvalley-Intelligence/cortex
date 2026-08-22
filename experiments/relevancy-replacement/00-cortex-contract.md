# Journal 00 — Cortex relevance contract (GATE 1)

Branch: `experiment/relevancy-replacement`. This is the "read Cortex, write its
contract, stop and show" gate. No arms built, no data downloaded, no label
mapping proposed yet — all of that is gated behind Ferosh's review of this doc.
Cortex code was read only, never modified.

## What Cortex's relevance scorer takes in

`POST /v1/relevance` (handler `src/api.mjs:261-381`), then poll
`GET /v1/relevance/:id` (`src/api.mjs:383-450`). Request body:

- `client` (string, **required**)
- `queries[]` (**required**, non-empty), each:
  - `query_id` (string, **required, unique** — the metric join key)
  - `query` (string, **required**)
  - `products[]` (**required**, non-empty), each `{ id (required, unique), title (required), description? }`
- optional: `rubric` (string ≤20000), `params` (default `{temperature:0, maxTokens:120}`), `k`, `min_context_window`, `fresh` (bypass cache)

**Query + product title only is sufficient** — the model prompt is literally
`Search query: {query}` / `Product title: {product.title}` (`src/relevance.mjs:157-165`).
`description` is optional and, if sent, is appended to the prompt. `id` is
required even though only the title is scored — it's the join key for metrics.
So every arm's input = (query, title); output must slot into the schema below.

## What it puts out

Per (query, product) pair, a **judgment**: `{ product_id, trace_id, grade, reason, from_cache }`
(`src/api.mjs:398,411`). `grade` is the integer label; `reason` is a short
free-text justification. Per-query it also computes ranking metrics
`{ ndcg, precision, average_precision, reciprocal_rank, k, candidates, relevance_mode }`
(`src/relevance.mjs:270-285`), and a batch `mean_ndcg`. Any arm we compare must
emit, per pair, an integer grade on the scale below (plus optionally a reason).

## The exact label values — READ FROM THE FILE, never hardcode

Single source of truth: `RELEVANCE_SCALE`, `src/relevance.mjs:24-29`. Verbatim:

| grade | meaning |
|---|---|
| 0 | Irrelevant - does not match the search intent at all |
| 1 | Marginal - same broad category but does not satisfy the intent |
| 2 | Relevant - satisfies the intent but is not an ideal match |
| 3 | Perfect - exactly what the searcher intended |

It is the ONE source: the judge prompt scale is generated from it
(`relevance.mjs:93-94`) and `parseJudgment` rejects any grade not in it
(`relevance.mjs:191-193`). Every arm and every dataset-label mapping will
`import { RELEVANCE_SCALE } from cortex/src/relevance.mjs` (or read the file),
never re-type these four values. Cortex's own note calls the 0–3 graded scale
"a proposed default rather than a discovered requirement" (`relevance.mjs:10-12`,
`HANDOFF.md` OQ-5) — worth remembering when we audit its labels.

## How it currently computes relevance

LLM-as-judge with a composed rubric (NOT embeddings). One model call per pair,
`temperature:0, maxTokens:120`, deterministic → cached. Prompt = fixed Cortex
frame (output format + the 0–3 scale, `relevance.mjs:85-97`) + rubric
(caller's or `DEFAULT_JUDGE_RUBRIC` `relevance.mjs:101-138`) + tail. The frame
and scale are NOT caller-overridable. Model comes from the provider chain
`DEFAULT_PROVIDERS` (`src/config.mjs:30-79`), default order **gemini-2.5-flash →
openrouter(poolside/laguna-xs-2.1:free) → local(ollama llama3.2:3b)**, override
via `CORTEX_PROVIDER_CHAIN`. Grade parsed from a one-line JSON `{"grade":n,"reason":"..."}`;
unparseable → surfaced as a failure, never silently coerced to 0.

## How fast it currently runs — MEASURED ON THIS MACHINE (not the docs)

The repo docs say "~60s/call" (`cache.mjs:6-7`, `MISSION.md:13`). **That is
stale for this M5.** Measured live today:

- Through `/v1/relevance` with the **default chain** (hit gemini, a CLOUD call):
  **~1.0 s/pair** (2 pairs → 2.0 s end to end), grades correct (3 for a matching
  water bottle, 0 for an office chair), ndcg 1.0.
- **On-device** `llama3.2:3b` via Ollama directly (the fair baseline for an
  "entirely on this machine, no API" replacement): **~0.3 s/pair warm**, ~2.9 s
  cold (first call = model load). Correct grade + reason.

**Implication for the task (flag for Ferosh):** the on-device speed bar is
sub-second per pair, not 60s. Arm B (llama3.2:3b prompted) is essentially what
Cortex-local already is, so a *speed* win has to come from a lighter model or
from batched logit-reading (Arm D reading label-token logits, no free-gen), and
the real prize is **accuracy** — with speed held at parity. The "beat Cortex on
speed AND accuracy" framing should be measured against Cortex-**local** (~0.3s),
and note that Cortex's shipping default is actually cloud-first.

## Repo conventions a builder must follow

Node ≥22 ESM, `.mjs`, **zero runtime deps** (built-in `node:sqlite`/`node:http`/
`node:crypto`). Tests: `node --test "test/*.test.mjs"` (`node:test` + `node:assert/strict`),
BDD-scenario named. `npm run validate` = two-pass gate needing real Ollama.
MDE project (`.mde/`, `MISSION.md`, `HANDOFF.md`); comments cite mission lines +
BDD ids. No pre-existing experiment-branch convention (repo was single-commit on
`main`). Constraint: Cortex must not edit sibling projects; its vendored metrics
(`src/vendor/retail-search-metrics.mjs`) are drift-checked byte-for-byte against
`~/code/retail-search`. Server runs at `http://127.0.0.1:7077`.

## STOP — awaiting Ferosh

Per the ask ("Do the Cortex contract and stop"): no further work until Ferosh
reviews this contract. Next gate after approval = propose the ESCI/WANDS →
`RELEVANCE_SCALE` label mapping and stop again.
