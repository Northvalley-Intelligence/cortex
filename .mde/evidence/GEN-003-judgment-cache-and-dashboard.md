# GEN-003 — Judgment cache + dashboard visibility

Deployed 2026-08-06 while Command Center was actively calling (drain-checked graceful restart;
`judgment_cache` table created additively via CREATE TABLE IF NOT EXISTS — no migration).

## Change 1 — read-through cache for relevance judgments

**Why.** Relevance judgments are deterministic (temperature 0), so a repeated request is the
SAME grade, not an approximation — and a local judgment is a 60s+ call. The dominant real case:
when eval-reports re-runs after fixing candidate capture, the *rankings* change but the
individual (query, product) *judgments* are mostly identical (judgments are rank-independent),
so a re-run is almost entirely cache hits.

**Key.** `sha256(stable([prompt, systemPrompt, params, modelScope]))` — the exact content sent
to the model. `systemPrompt` folds in the rubric (via the composed prompt); `prompt` folds in
query + product title/description; `modelScope` is the configured judge-model chain. Any change
to rubric, product text, params, or judge model MISSES — guarding the MISSION.md:93
stale-confident-number risk. Only succeeded, parseable grades are written (a bad run is never
frozen); INSERT OR IGNORE makes re-polls idempotent.

**Flow.** `/v1/relevance` computes a per-pair key, serves hits from `judgment_cache`, and only
enqueues misses as model calls; a fully-cached batch creates zero calls and is `complete`
immediately. Results seed cached judgments (each keeps `source_trace_id`, so it stays auditable
in the viewer) and write-through fresh successes on poll. `cache:{hits,misses,bypassed}` on
submit + results; `from_cache` per judgment; `fresh:true` bypasses; `POST /v1/admin/prune
{cache:true}` clears (escape hatch for an in-place model re-pull the key can't detect).

**Live verification.** Same batch twice against llama3.2:3b: first run miss (2.1s, grade 3,
from_cache false); identical second run hit (0.0s, `complete` immediately, grade 3, from_cache
true, provenance = same trace as the fresh judgment).

**Tests.** `test/cache.test.mjs` (13): key sensitivity (prompt/rubric/params/model each miss),
param-order stability, provenance, INSERT-OR-IGNORE idempotency, stats/clear, and HTTP
hit/miss/`fresh`/rubric-miss. Registered in the gate.

## Change 2 — dashboard: windowed Jobs count + Served-from-cache

**Trigger.** Ferosh could not see this-morning's eval jobs. Investigation: the data was present
(two `ecommmerce-eval` jobs, 145 + 86 judgments, all succeeded) and `/v1/metrics` reported 231
job-calls correctly — but Command Center's live `status_adjudication` calls (every ~2 min) fill
the 15-row Recent-calls list, pushing the 12h-old job-calls off, and there was **no
jobs-in-window aggregate** anywhere. (The dashboard does auto-refresh every 3s — that was not
the issue.)

**Fix.** `jobMetrics(db, sinceMs)` adds `jobs_in_window` + a windowed cache block (served /
judged / hit-rate, derived from each job's recorded cache summary) to `summary()`; the strip
gains a **Jobs** cell and a **Served from cache** cell. Backward-compatible with pre-cache jobs
(both metric and results write-through guard for missing `cache`/`cache_key`).

## Residual / notes
- The cache keys on model *name*, not a weights digest, so a silent same-tag re-pull isn't
  detected — documented, with `prune {cache:true}` as the escape hatch.
- A pruned source trace leaves the cached grade valid but its provenance link dangling; the
  grade is still served (grade/reason live in the cache row).
