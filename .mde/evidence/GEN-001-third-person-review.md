# Third-Person Validation (VS-CONTRACT) — caller perspective

- Generation: GEN-001
- Date: 2026-07-16
- Method: an independent agent adopted the perspective of the two consuming projects and
  exercised the live API at localhost:7077 with real curl, reading src/ for behaviour.
- Mission ref: MISSION.md:81 (independent check of the consuming-project experience).

## Why this pass mattered

It found two HIGH silent-correctness bugs that the first-party test suite missed, because
that suite only ever sent well-formed input. Both are instances of the mission's own core
failure mode — a harness fault that masquerades as a data or prompt fault — so they were
fixed immediately and given regression coverage.

## Findings and disposition

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| HIGH-1 | High | `/v1/calls` and `/v1/jobs` pre-picked `system_prompt` before the normalize gate, so a typo (`sytsem_prompt`) was silently dropped at the HTTP boundary — the exact silent-system-prompt bug, reachable by real callers. | **FIXED** — both endpoints route through `normalizeCallInput`; unknown top-level fields are rejected with a 400 naming the field. Live-verified: typo → 400. Regression: `test/contract-guards.test.mjs`. |
| HIGH-2 | High | `query_id` was unvalidated but is the NDCG join key; omitting it pooled distinct queries into one bucket keyed `undefined` and emitted a single fabricated `mean_ndcg` (reviewer reproduced 0.613). | **FIXED** — `query_id` now required and unique; product ids required and unique per query. Live-verified: missing query_id → 400. Regression added. |
| GAP-1 | High (retrofit) | No OpenAI-compatible `/chat/completions` surface; the Command Center posts `messages[]` and reads `choices[0].message.content`. Retrofit is a code change to its egress function, not a base-URL re-point. | **Documented decision**, not silently expanded. HANDOFF.md states the caller flattens messages→prompt/system_prompt. A compatibility shim is a possible future Cortex generation — flagged for Ferosh, not built tonight (scope). |
| GAP-2 | High (retrofit) | `reasoning_effort` and JSON-mode (`response_format`) were silently dropped. | **FIXED** — both forwarded to OpenAI-compatible providers; `response_format:json` maps to Ollama `format:"json"`. Regression added. |
| GAP-3 | Medium | No per-call model/chain pinning; routing is server-global. | **Deferred** — recorded as a Gen-2 candidate. Today's callers get the configured chain; per-call pinning is an additive feature, not a correctness gap. |
| GAP-4 | Medium | Relevance requires stable product ids that ecommmerce-eval does not yet mint. | **Expected** — this is R-12 / OQ-6, already the documented upstream precondition in HANDOFF.md. |
| Confusion notes | Low | `succeeded` does not imply valid JSON (content validity stays the caller's job); `effective_prompt_budget` is the *smallest* eligible window (raise the floor to widen it); a missing API key classifies as availability and is masked by fallback (visible only in trace/metrics); `/health` 404s vs `/v1/health`. | **Documented** in HANDOFF.md and the capability endpoint's `note`. The API-key-masking point is worth a caller-side alert and is noted for the retrofit. |

## Net assessment (reviewer's words, paraphrased)

The trace/diagnosis model, the relevance metric guards, and the availability-vs-content
distinction the Command Center depends on are well built and faithfully reproducible. The two
HIGH silent-correctness bugs stood between Cortex and a trustworthy retrofit; both are now
fixed and covered. The remaining items are retrofit-shape decisions (OpenAI-compatible surface,
per-call pinning) rather than defects, and are surfaced for Ferosh rather than silently
resolved.
