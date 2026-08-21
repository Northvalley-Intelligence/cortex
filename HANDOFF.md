# Cortex API — Handoff for Consuming Projects

This is the contract the Command Center and evaluation-reports call into. **Cortex does not
edit either project** (MISSION.md:48). Each project's own session performs its retrofit; this
document is the input to that work.

Base URL (local, loopback only): `http://127.0.0.1:7077`
Version prefix: `/v1`. All requests and responses are JSON.

Contract model: **submit-and-retrieve**. Submission returns an ID immediately and never blocks
on the model. You get an answer by polling, or by passing an optional bounded `wait_ms`. Every
result carries its `trace_id` so any output can be walked back to its full input/output record.

---

## Core endpoints

### `POST /v1/calls` — one latency-sensitive call
```json
{
  "client": "command-center",
  "purpose": "routing",
  "prompt": "Operator message: ...",
  "system_prompt": "You are a command router. Reply ONLY JSON {...}",
  "params": { "temperature": 0.1, "maxTokens": 200 },
  "min_context_window": 8192,
  "wait_ms": 45000
}
```
- Returns `202 { call_id, trace_id, status: "queued" }` immediately (no `wait_ms`).
- With `wait_ms` (max 120000): returns `200` with `{ output, status, resolved_by, trace_id }`
  if it finishes in time, else `202 { status: "pending", trace_id }`. The work continues
  either way — `wait_ms` is sugar over polling, never a change in semantics.
- `client` and `prompt` are required. Calls are scheduled ahead of job-calls.

### `GET /v1/calls/:id` — retrieve a result
`{ call_id, trace_id, status, output, error, resolved_by }`.
`status` ∈ `queued | executing | succeeded | failed | exhausted`.

### `GET /v1/traces/:id` — the full trace (the debugging surface)
Full input, output, per-attempt provider records (with real error messages), timing, token
counts (sent estimate **and** evaluated), and a `diagnosis` block that attributes the outcome
to `prompt_or_model`, `harness`, `availability`, or `caller`. This is how you tell whether a
bad answer was the prompt's fault or not.

### `POST /v1/jobs` — a batch of calls
```json
{ "client": "ecommmerce-eval", "purpose": "...", "calls": [ { "prompt": "...", "system_prompt": "...", "params": {}, "min_context_window": 8192 }, ... ] }
```
Returns `202 { job_id, call_ids[], trace_ids[] }`. Poll `GET /v1/jobs/:id` for status and
counts (`total/queued/executing/succeeded/failed/exhausted`), `GET /v1/jobs/:id/results` for
all outputs. A job completes automatically when every call is terminal; partial completion is
visible in the counts, never collapsed into a single verdict.

### `GET /v1/capabilities?min_context_window=N` — check before you submit
Tells you whether a declared context window is satisfiable and what the effective prompt
budget is (the smallest eligible provider's window). Use this to avoid submitting a prompt
that would be refused.

### `GET /v1/metrics`, `GET /v1/health`, `GET /` (dashboard)
Usage and reliability aggregates, provider health, and the human dashboard.

---

## For the Command Center

**The one change that matters:** today all LLM egress goes through one function,
`callSingleCuratorProvider` (`src/curator-llm.mjs:~918`), which posts an OpenAI-style
`/chat/completions` body and reads `choices[0].message.content`. Repoint that single function
at Cortex's `POST /v1/calls` with a bounded `wait_ms`, and you inherit tracing, the provider
chain, durability, and quota visibility without touching any other file. The `usageId` you
already thread through becomes the `trace_id`.

Cortex does **not** expose `/chat/completions`, so this is a small reshape, not a base-URL
swap. Two mappings:

**Request — flatten `messages[]` into `prompt` + `system_prompt`:**

| your current field | Cortex field |
|---|---|
| the `system` message content | `system_prompt` |
| the `user` message content | `prompt` |
| `temperature` | `params.temperature` |
| `max_tokens` | `params.maxTokens` |
| `reasoning_effort` | `params.reasoningEffort` *(now forwarded)* |
| `response_format` | `params.responseFormat` *(now forwarded; also sets Ollama JSON mode)* |
| *(none — server-config)* | `min_context_window` (declare your routing-context floor, e.g. 8192) |

```json
POST /v1/calls
{
  "client": "command-center",
  "purpose": "routing",
  "system_prompt": "<your planner system string ending in the Schema: {...} literal>",
  "prompt": "Operator message: <cmd>\nSnapshot hash: <hash>\n<context json>",
  "params": { "temperature": 0.1, "maxTokens": 1200, "reasoningEffort": "low", "responseFormat": { "type": "json_object" } },
  "min_context_window": 8192,
  "wait_ms": 45000
}
```

**Response — read `output` instead of `choices[0].message.content`:** on the `200`,
`{ output, status, resolved_by, trace_id }`. Your `parseCuratorJson` /
`sanitizePlannerDecision` run on `output` exactly as they do today.

**Fields are now strict.** Cortex rejects an unknown top-level field or an unknown key inside
a call with a `400` naming it (this closes a silent-drop bug — a typo'd `system_prompt` used to
vanish). Allowed top-level: `client, purpose, prompt, system_prompt, params, min_context_window,
wait_ms`. So spell them exactly.

**What Cortex preserves that you rely on:**
- **Availability vs content failures.** Cortex falls back ONLY on availability failures
  (429/quota/timeout/transport). A reachable model's bad answer is returned as
  `status: "failed"`, `error.code: "content_failure"`, and is NOT retried on the next provider
  — exactly your current `isProviderAvailabilityFailure` behaviour. Confirmed by test.
- **Strict JSON output stays your concern.** `succeeded` means a model answered, not that the
  answer is valid JSON. Cortex records and returns raw text; keep parsing and rejecting junk on
  your side. (Use `params.responseFormat` to nudge JSON mode, but still validate.)

**What Cortex does NOT do (by design, flagged in the caller review):**
- **No per-call model/provider pinning (GAP-3).** Routing is server-global config; you get the
  configured chain, not a per-call model choice. Tell me if you need per-call pinning.
- **No one-shot schema-repair pass.** If you want that centralised it is a future Cortex
  generation, not assumed here.
- **No push.** You poll or use `wait_ms`.
- **A missing API key classifies as availability** and is masked by fallback — visible in the
  trace/metrics and the dashboard Quota column, but not in the call result. Watch the dashboard.

**Migration note (needs your decision — OQ-2):** your routing call is operator-blocking today.
`wait_ms` gives a clean drop-in (a bounded synchronous-feeling call), but the mission's intent
is that even live calls are async. Recommend starting with `wait_ms` for a transparent swap,
then moving the UI to poll if you want the full async benefit.

**Redaction:** keep running `redactSecrets` before you call Cortex. Cortex records the payload
it receives (post-redaction), and must never receive pre-redaction state.

**Verify the retrofit end to end:** submit one real operator command through Cortex, then open
`GET /v1/traces/<trace_id>` and confirm the prompt, the resolving provider, and the
`diagnosis` block are all what you expect — that trace is now your debugging surface.

---

## For evaluation-reports

**Use `POST /v1/relevance`** — purpose-built for your case:
```json
{
  "client": "ecommmerce-eval",
  "min_context_window": 8192,
  "k": 10,
  "rubric": "…optional domain judging criteria…",
  "queries": [
    { "query_id": "q1", "query": "womens waterproof rain jacket",
      "products": [ { "id": "<stable-id>", "title": "...", "description": "..." }, ... ] }
  ]
}
```
Returns `202 { job_id, call_ids, rubric_hash, using_default_rubric }`; poll `GET /v1/relevance/:id`
for graded judgments (0–3) per product and `nDCG` per query, plus `mean_ndcg` and `rubric_hash`.
Each (query, product) judgment is its own trace, so every grade is auditable.

**Judge prompt is composed.** Cortex owns the frame — the one-line-JSON output contract and the
0–3 scale — and these are NOT overridable. `rubric` (optional) is your domain criteria (notation
rules, product-type rules, examples); Cortex wraps it in the frame and captures the full composed
prompt in every trace. `rubric_hash` is a stable id of the exact instructions, so a re-run is
comparable. Omit `rubric` to use Cortex's default ecommerce rubric (handles measurement-notation
equivalence like `1/2-in`=`1/2 in.` and `#8`=`no 8`, plus product-type discrimination). Do NOT
put the scale/format in your rubric — the frame owns them. Empty/non-string `rubric` → `400`.

**Judgments are cached.** Deterministic (temp 0) judgments are served from the grade that first
produced them, keyed on `hash(composed prompt + rubric_hash + params + judge model)`. A re-run
after a ranking/pipeline change is almost all cache hits (judgments are rank-independent) and
returns in ms; a fully-cached batch is `status: "complete"` with zero model calls. Response and
results carry `cache: { hits, misses, bypassed }`; each judgment has `from_cache` and a `trace_id`
back to its origin. `"fresh": true` forces a re-judge; `POST /v1/admin/cache/clear` clears the
cache (use after an in-place model update the key can't detect). Cache clearing is separate from
trace pruning (`POST /v1/admin/prune`).

**Two prerequisites in YOUR repo before NDCG is meaningful (Cortex cannot make these changes):**
1. **Capture ≥10 candidates per query.** `src/lib/rendered-evidence.mjs:126` caps at 8.
   NDCG@10 over 8 items is @8 — Cortex reports the real `k` and warns rather than padding.
2. **Provide stable product IDs.** That same function builds an `hrefs` set and discards it;
   keep the href as the product `id`. Titles are not a safe join key, and
   `POST /v1/relevance` rejects a product with no `id`.

**NDCG correctness:** Cortex reuses `retail-search`'s metric implementation verbatim (vendored,
drift-checked), and validates against its published BEIR sanity targets. It does not invent a
second NDCG. The risk it guards is judgment quality, not the math — judgments are temperature-0
and unparseable grades are surfaced as failures, never coerced to 0.

**Grading scale:** proposed 0–3 graded relevance (0 irrelevant → 3 perfect). Confirm this is
the scale you want (OQ-5); it is not yet fixed by anything in your repo.

---

## Open items that affect this contract (Ferosh decides)

- **OQ-1** provider order (local-first vs cloud-first) — changes latency and cost posture.
- **OQ-2** Command Center: `wait_ms` drop-in vs full async migration.
- **OQ-4** fairness floor number (default: a job-call every 4th dispatch).
- **OQ-5** relevance grading scale (default: 0–3 graded).
- **OQ-6** whether Gen 1 scope includes the eval-reports candidate-capture handoff.

See `.mde/mission-clarification.md §10` for the full list.
