# Cortex — Session Handoff

_Written 2026-08-18. Context: the MDE Control Center is being decommissioned; this captures Cortex's state so anyone can resume without it._

## 1. What was being worked on

Cortex is the shared LLM execution + traceability service (zero-dep Node, `node:sqlite` + `node:http`, port 7077). This session delivered a run of incremental features on top of the core queue/fallback/trace engine:

- **Output-truncation diagnosis** — capture provider stop-reason (`done_reason`/`finish_reason`); `done_reason=length` is diagnosed as a caller token-budget fault, not a bad model.
- **Composed judge prompt** — `POST /v1/relevance` takes an optional `rubric`; Cortex owns the fixed frame (0–3 scale + one-line-JSON contract), caller supplies domain criteria. Default rubric = the ecommerce notation/product-type rubric (fixes the `1/2-in`/`#8` notation defect). `rubric_hash` echoed.
- **Judgment cache** — deterministic relevance judgments served from a prior grade instead of a 60s+ model call. Keyed on `hash(composed prompt + rubric_hash + params + judge-model-scope)`. Call-level; scoped to relevance judgments only. `fresh:true` bypasses; write-through on results poll; provenance kept (`source_trace_id`).
- **Dashboard/viewer visibility** — windowed Jobs count + "Cache hits" measure on the dashboard; paginated + filterable **Calls grid** (`/v1/traces` gained `offset`/filters/`total`, plus `/v1/facets`); paginated **Jobs list** in the viewer (`/v1/jobs`); viewer `?job=` deep-link now scopes to that job.
- **Settings page** (`/settings`) — moved trace-store + judgment-cache management off the dashboard. Trace store and cache are now clearly SEPARATE sections with separate endpoints.

Full narrative + rationale for each is in `.mde/decisions.jsonl` (DEC-008 … DEC-018) and `.mde/evidence/GEN-00{2,3}-*.md`; control-center stream reports (GEN-002…GEN-005) are in `.mde/control-center-report.jsonl`.

## 2. Current state

**Deployed & healthy.** Live server on `127.0.0.1:7077` (last PID 54031), launched detached as `node --env-file-if-exists=.env.local src/server.mjs`, logging to `cortex-server.log` in the repo root. DB at `data/cortex.db` (~54 MB). Real clients only: `command-center`, `ecommmerce-eval`, `mde-control-center`.

**Tests:** full suite green (111–112 tests); Validation Gate passes twice with real Ollama (`node scripts/validation-gate.mjs`). Everything built this session was deployed via drain-checked graceful restarts.

**Uncommitted / unpushed:** this repo reports `Is a git repository: false` — there is no git tracking here, so "uncommitted changes" don't apply. All work is in the working tree on disk and is already running in the live process. Files touched this session include `src/{api,trace,cache,queue,metrics,db,relevance,executor}.mjs`, `public/{index,viewer,settings}.html`, `scripts/validation-gate.mjs`, `test/*.test.mjs`, `HANDOFF.md`, and `.mde/*`.

**Known cosmetic state:** the judgment cache was cleared during endpoint verification, so it currently reads ~0 entries and re-warms as evals run. The dashboard "Cache hits" (windowed activity) is independent of current cache size — this is expected, not a bug.

## 3. Exact next steps for whoever resumes

1. **New session start:** read `MISSION.md`, `MISSION_UPDATES.md`, and `.mde/` state (this file, `decisions.jsonl`, `evidence/`, `validation-strategy.json`). The central `~/code/mde` platform memory is going away — treat this repo's `.mde/` as the source of truth going forward.
2. **To run/verify:** start the server with `npm start` (or the detached command above); confirm `GET /v1/health`. Run tests with `npm test`; run the gate with `node scripts/validation-gate.mjs` (requires real Ollama `llama3.2:3b` at `localhost:11434`).
3. **Caller retrofits are the open work** (owned by those repos, not Cortex): Command Center and evaluation-reports consume Cortex per `/tmp/cortex-eval-reports-handoff.md` and the "For …" sections of `HANDOFF.md`. eval-reports still must land two changes in ITS repo before live end-to-end NDCG works: capture ≥10 candidates/query and use stable product IDs (hrefs). Command Center should remove its old LLM usage tracking.
4. **Standing decisions for Ferosh:** OQ-1…OQ-6 in `.mde/control-center-report.jsonl` remain his to decide (grading scale OQ-5, candidate-capture scope OQ-6, etc.).

## 4. Blockers / do not break

- **Never modify consuming repos** (MDE principle) — Cortex adjusts its own API if a caller doesn't fit; callers retrofit themselves.
- **Deploys = a graceful restart, drain-checked first.** Command Center calls live every ~2 min; wait for the queue to idle, `SIGTERM` (server drains), relaunch detached. The durable queue makes restarts safe, but don't restart while an eval batch is mid-run without checking — someone may be relying on that output. **Wait for an explicit signal before any service gap.**
- **Don't break the invariants that make a grade trustworthy:** the judge FRAME (0–3 scale + JSON contract) is not caller-overridable; unparseable grades are surfaced as failures, never coerced to 0; incomplete rankings return `ndcg:null`; the cache key must include `rubric_hash` + model scope (or a rubric/model change would serve a stale grade). Trace pruning and cache clearing are SEPARATE endpoints (`/v1/admin/prune` is traces-only; `/v1/admin/cache/clear` for cache) — do not re-merge them.
- **Static pages (`index/viewer/settings.html`) are served per-request** → UI edits go live without a restart; only backend (`src/*.mjs`, route registration) changes need one.
- **Credentials** live in gitignored `.env.local` (copied from Command Center) — never commit them. The trace store redacts secrets on capture.
- **Ollama silent truncation** is the core anti-demo guardrail: set `num_ctx` per call and verify `prompt_eval_count`; VS-CTX must run against real Ollama before phase exit (never skip it).
