# Cortex Design Principles

Project-specific design rules, additive to central MDE standards. Recorded so future
generations and the UI pre-review enforce them.

## P-1 — Views must not lose identity or connections
Source: Ferosh, 2026-07-29 (reviewing the trace views).

A view must not collapse a multi-step process to its final state. A list row that shows only
the resolving provider hides that a call was tried on gemini and openrouter first; that lost
connection is exactly what makes the trace useful ("who handled this, in what order").

Rule: render the ordered lineage (source → … → resolver), dim or strike non-final steps, but
never omit them. Carry the ordered data to the client — don't aggregate it away in the query.

Applies to: provider fallback paths, job→call grouping, retry chains, attribution/ownership
trails, and any "what touched this and in what order" record.

Enforced in: `listTraces` returns `provider_path` (ordered attempts, not just `provider_id`);
the dashboard Provider column and the viewer tree/detail render the full path. Test:
`test/fallback.test.mjs` — "listTraces preserves the ordered provider path".

## P-2 — Traces record what actually happened, not what was intended
(Established GEN-000/001.) Record evaluated tokens vs sent tokens; attribute faults to the
real layer (harness/prompt/availability/caller); never let a summary imply a state the
evidence doesn't support (e.g. "succeeded" over a truncated prompt).
