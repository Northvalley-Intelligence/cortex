# VS-UI Agent Pre-Review (BDD-017) — Cortex dashboard

- Generation: GEN-001
- Date: 2026-07-16
- Reviewer: agent (automated pre-review, ahead of Ferosh per MISSION.md:73,81)
- Method: rendered dashboard at http://localhost:7077/ inspected live in Chrome with real
  data (9 real calls including live Gemini quota-exhaustion fallbacks), plus the trace-detail
  view. Two screenshots captured.

This pass runs BEFORE founder review so review time is spent on judgment, not obvious defects.
It checks the exact things Ferosh looks for: crowded, over-complicated, redundant, unclear
hierarchy, and — the practical one — does the screen actually show whether the system is
doing its job.

## Verdict: PASS with two Low findings. No Critical/High UI defects.

## Checklist

| Question | Finding |
|---|---|
| Crowded? | No. One status strip (8 tiles), a 3-row provider table, a recent-calls table. Generous spacing, one screen. |
| Over-complicated? | No. Reads at a glance; no nested panels, no controls competing for attention. |
| Redundant / repeated? | No. Each metric appears once. `Failed` deliberately merges failed+exhausted into one number rather than showing two near-identical tiles. Fallback rate is shown once in the strip and decomposed per-provider in the table — that is decomposition, not repetition. |
| Hierarchy clear? | Yes. Canonical status strip first (system state), then provider reliability, then recent calls. Severity color is consistent (green ok / amber warn / red bad). |
| Does it show the system is working? | **Yes, strongly.** With real data the dashboard immediately surfaced that OpenRouter is 100% failing (free-tier daily limit), Gemini is at 78% with a 22% availability-failure rate, overall fallback rate 22%, and Truncated = 0. An unreliable model is identifiable in one glance — the mission's headline UI requirement (MISSION.md:71). |

## Canonical status (MISSION clarification §9)

Queue depth and provider health appear once, in the top strip, and are not repeated across
screens. `Providers up 3/3` is the single health indicator; the per-provider table elaborates
rather than duplicates it. PASS.

## Diagnostic usefulness (the mission's real test)

The trace-detail view (`GET /v1/traces/:id`) was exercised on a real fallback trace. It showed
the full input (prompt, system prompt, params, declared context window), the output, the
resolving provider, timing (queue wait 223ms, total 923ms), and a per-attempt list. Attempt 1
carried the **real** Gemini `429 "You exceeded your current quota"` classified as
`availability`; attempt 2 resolved on local. A reader can attribute the outcome without
reading logs. This is the "trace lookup for a bad output" workflow, and it works.

## Findings

### UI-1 (Low) — two empty tiles in the status strip
The status strip auto-fills a grid; with 8 tiles the second row leaves two blank cells,
a slight visual imbalance. Cosmetic only. Options: promote two per-provider health dots, or
reflow to a 4-wide grid. Not blocking.

### UI-2 (Low) — trace detail is raw JSON via the browser's native viewer
`GET /v1/traces/:id` returns JSON, which the browser renders with its built-in pretty-printer
rather than a designed trace page. For an internal single-user diagnostic tool this is
arguably correct — it is complete, copyable, and unambiguous, and MISSION.md:40 puts broad
app-style UI out of scope. But the mission does mention trace inspection "through the UI"
(MISSION.md:35), so a future generation may want a rendered trace view that foregrounds the
`diagnosis` block. Recorded as a deferred enhancement, not a defect.

### UI-3 (Medium) — FOUNDER-CAUGHT: recent-calls table did not distinguish call from job-call

My automated pre-review missed this; Ferosh caught it on review (2026-07-17). The "Recent
calls" table showed every call including job-calls (correct — a job decomposes into calls),
but rendered no column distinguishing a live `call` from a batch `job`-call, and never
surfaced the `job_id` a job-call belongs to. It even fetched `priority_class` and discarded
it. So a batch's calls were indistinguishable from live calls and from each other. This is
squarely a "does the screen show what the system is doing" gap — the exact thing the pre-review
is supposed to catch — so recording it as a pre-review miss, not just a fix.

**FIXED:** added a Type column (green `call` vs grey `job` + shortened `job_id`); `listTraces`
now returns `job_id`. Live-verified in the dashboard; trace/API tests still pass (19/19). A
lesson for the VS-UI validator: check that each surfaced field is actually *rendered*, and that
a mixed list labels the kinds it mixes.

## Anti-Demo confirmation

The dashboard was reviewed with REAL data produced by REAL provider calls (including live
quota exhaustion), not seeded placeholder rows. The numbers on screen reconcile with the
`/v1/metrics` endpoint, which VS-TRACE independently recomputes from raw trace rows. The
screen is not a demo shell.
