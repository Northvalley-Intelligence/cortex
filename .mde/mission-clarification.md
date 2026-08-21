# Mission Clarification — Cortex

- Generation: GEN-000
- Mission version: MISSION-2026-07-16-GEN-000
- Date: 2026-07-16

Generation 0 rule: this document translates MISSION.md into real-world outcomes, decision
owners, and lifecycle rules **before** BDDs or implementation are accepted. Where the
mission is ambiguous or contradicted by observed reality, that is recorded here as an open
question rather than silently resolved by the agent.

---

## 1. What Cortex really is

Cortex is **infrastructure whose product is evidence**, not an LLM wrapper.

The mission's own framing makes this explicit: the local LLM is *already live* in the
Command Center and *already has metrics*. What is missing is the record of what went in and
what came out. So the thing Cortex uniquely adds is not model access — that exists and works
— it is **traceability that makes prompts improvable**.

This reframing has a sharp consequence used throughout this document:

> A Cortex feature that executes calls correctly but records them incompletely has failed
> its mission. A Cortex feature that records completely but executes no faster than today
> has still advanced the mission.

Everything else (queue, priority, fallback, UI) exists to make that record trustworthy and
readable.

## 2. Real-world outcomes

| # | Mission capability | Real-world behaviour it must teach, enforce, or simplify |
|---|---|---|
| O-1 | Submit-and-retrieve API | A calling project stops owning model access, retries, and instrumentation. It hands over work and gets a handle. |
| O-2 | Trace by ID | When an answer is wrong, Ferosh can determine *within one lookup* whether the prompt or the model caused it — and revise the prompt with evidence. |
| O-3 | Durable queue | Work survives the machine sleeping. Submitting work is safe at any hour. |
| O-4 | Call-over-job priority | A live command stays responsive while a 1000-call batch is running. |
| O-5 | Provider abstraction + fallback | Quota exhaustion degrades service instead of stopping it, and no caller changes. |
| O-6 | Context-window floor | A prompt never silently loses its instructions because routing picked a smaller model. |
| O-7 | Metrics dashboard | An unreliable model or a failing prompt is visible at a glance, without reading logs. |

## 3. Decision owners and authority boundaries

| Decision | Owner | Boundary |
|---|---|---|
| Mission scope and phase content | Ferosh | Agent proposes, does not self-authorize scope. |
| Provider order / cost posture | **Ferosh** | See Open Question OQ-1 — currently contradictory. |
| Prompt content of consuming projects | The consuming project | Cortex executes and records prompts; it must not rewrite them. |
| Command Center retrofit | Command Center session | **Cortex must not edit `mde-control-center`** (MISSION.md:48). Handoff only. |
| Trace retention / redaction policy | Ferosh | See Open Question OQ-3 — collides with an existing security control. |
| Deploy / irreversible actions | Ferosh | Agent surfaces, never performs unilaterally. |

## 4. Lifecycle: creation to completion

A **call** is the unit of execution and traceability. A **job** is an aggregate of calls.

```
submitted -> queued -> leased -> executing -> (succeeded | failed | exhausted)
                 ^                    |
                 +----- requeued -----+   (machine sleep / transport failure)
```

Rules that must survive time passing, reload, and storage:

- **Automatic completion:** a job completes when every constituent call reaches a terminal
  state. Partial completion is a real state and must be retrievable — a batch where 900 of
  1000 calls succeeded is not simply "failed".
- **No silent loss:** a call leased to a worker that dies (machine sleep) must return to
  the queue, not sit `executing` forever. This requires a lease with an expiry, not an
  in-memory flag.
- **No duplicate execution:** requeue must not double-charge a paid provider. At-least-once
  delivery with idempotent recording is the realistic target; exactly-once is not claimed.
- **Terminal means terminal:** `exhausted` (every provider in the chain failed) is distinct
  from `failed` (the model answered, but the answer was rejected). The Command Center
  already encodes this distinction and it must be preserved — see §6.

## 5. Destination of work, results, and notifications

- Tasks/requests arrive via the submission API and land in the durable queue.
- Results are retrieved by ID via the API (pull). **No push/callback is in scope** — the
  mission describes submit-and-retrieve only.
- The trace ID accompanies the returned output, so a result can always be walked back to
  its full trace (MISSION.md:35).
- The UI is the destination for *human* attention: usage, reliability, and trace inspection.

## 6. Observed reality that the mission does not yet reflect

Generation 0 surveyed the two consuming projects and the live local runtime. Four findings
materially affect the design and are recorded here because they change what "done" means.

### 6.1 The local model is already the *third* fallback, not the primary

MISSION.md:45 states "Local-first: primary execution is a local model." The Command Center's
**live** config (`mde-control-center/.mde/control-center/settings.json`) is already:

```
Gemini (gemini-2.5-flash)  ->  OpenRouter (free tier)  ->  local (llama3.2:3b)
```

which matches MISSION.md:32's fallback chain and **contradicts MISSION.md:45's "local-first"**.
This is not a small wording issue: it changes the latency contract, the cost posture, the
context-window floor, and which scenarios are Critical. Raised as **OQ-1**.

### 6.2 "Even live calls take roughly a minute" is a local-cold-start figure

The ~1 minute figure (MISSION.md:13) — used to justify submit-and-retrieve *for every
caller* — reflects the local path. Live timeouts are 30s for Gemini primary and 90s for the
local fallback, and the local wrapper pins `keep_alive: -1` precisely because cold reloads
of ~5.5GB "were blowing past Control Center's 60s routing timeout".

The submit-and-retrieve contract is still the right default (it is what makes O-3 durable),
but the *justification* is "the slowest eligible provider is slow", not "all calls take a
minute". Worth stating correctly, because the Command Center's routing path is
**operator-blocking today** — the UI disables the send button and awaits the call. Moving it
to submit-and-retrieve is a real UX change to that project, not a transparent swap. Raised
as **OQ-2**.

### 6.3 Full input capture collides with an existing secret-redaction control

MISSION.md:5 requires Cortex to record "the full input and output of every call". The
Command Center runs `redactSecrets` (default on) over context *before* serialization, so
secrets never leave that process today. If Cortex captures the input it receives, it
captures post-redaction data — which is correct and must stay that way. But "full input"
must be defined as **"the exact payload sent to the provider"**, not "the caller's raw
state". Otherwise Cortex becomes the first component to durably persist secrets, and the
trace store becomes a credential store. Raised as **OQ-3**.

### 6.4 Availability failures and content failures are not the same failure

The Command Center deliberately falls back **only** on availability failures (429, quota,
rate limit, timeout, network, 401/403). A reachable model returning a bad answer does *not*
trigger fallback — the comment explains why: "a reachable model's bad answer is a quality
signal, not an availability one."

If Cortex centralizes fallback, this distinction is a **non-obvious hard requirement**.
Falling back on content failure would burn the whole provider chain on one bad prompt and —
worse — would destroy the mission's core signal, because "the prompt was bad" would be
laundered into "the provider was unavailable". This is now a Critical BDD, not a detail.

### 6.5 The first live use case is blocked upstream, in a repo Cortex may not edit

MISSION.md:37 makes "evaluation-reports submits search-term/product sets, Cortex returns
relevance judgments and NDCG" the proof of the end-to-end path. Generation 0 surveyed that
project and found the proof is **not currently runnable**, for reasons outside Cortex:

- **NDCG@10 needs 10 candidates; only 8 are captured.** `ecommmerce-eval`'s
  `src/lib/rendered-evidence.mjs:126` hard-caps `titles.length < 8`, while recording up to
  121 visible products. NDCG over an 8-item list is @8, not @10.
- **There are no stable product IDs.** The same function builds an `hrefs` Set for dedup and
  then **discards it**, keeping only `hrefs.size`. Titles truncated to 90 chars are not a
  safe join key, and ranking metrics are keyed on IDs.
- **The primary surface captures no products at all.** `submitted-search` observations carry
  only an `html_excerpt`; only `rendered-search` yields titles, and it ran for just 27
  observations.

Each fix is small (the href is already in hand at that line), but they are changes to
**`ecommmerce-eval`, a separate repo with its own session**. Under MISSION.md:48 Cortex must
not make them. They also require re-running inspections — existing evidence cannot be
retrofitted. This is a **hard dependency with a handoff, not a Cortex task**. Raised as
**OQ-6**; tracked as R-12.

### 6.6 The scale assumption is ~10 calls per job, not thousands

The mission frames jobs as large batches. Reality: ~10 queries x 8 candidates ≈ 80 judgments
per report, batching naturally to **~10 calls**; the entire historical corpus is ~85 queries.
The largest run on record is ~200 calls. Nothing implies 1000-call scale.

This does **not** remove the need for priority and fairness — a 10-call job against a
~1-minute-per-call local model still blocks a live command for ~10 minutes, which is exactly
the mission's concern. But it does mean queue design should be judged on *correctness and
durability*, not throughput engineering. Building for thousands of calls would be
over-engineering against the evidence.

### 6.7 NDCG already exists, is correct, and is not in this project

`ecommmerce-eval` has **no NDCG and no LLM calls** — it is 100% deterministic scraping, and
Cortex would be its first LLM integration. What exists today is substring keyword matching
that the code itself repeatedly disclaims as "not calibrated product-level judgments."

A correct, tested implementation already lives in **`retail-search`**
(`src/evaluation/metrics.js`): `ndcgAtK` uses the standard log2 discount, builds ideal DCG by
sorting qrels by gain descending truncated to the same k, guards `idealDcg == 0`, and
supports `graded` (2^g − 1), `binary`, and `linear` modes. Generation 0 read it and found no
defect.

Two consequences:

- **Do not rewrite NDCG.** Reuse `retail-search`'s implementation. Cortex's job is to produce
  the *graded judgments* that feed it, not to re-derive a ranking metric — and a second,
  subtly-different NDCG in the portfolio is a plausible-but-wrong-numbers risk (§7.5).
- **The reference set for validating the math already exists.** `retail-search`'s BEIR
  registry carries `publishedBm25NdcgAt10` sanity targets (SciFact 0.665, NFCorpus 0.325,
  TREC-COVID 0.656). MISSION.md:77 asks for "NDCG correctness against a known reference" —
  this is that reference.

Note: `retail-search` is **not registered in the central portfolio** (`PROJECTS.yaml`), so
this reuse would create an unregistered cross-project dependency. Tracked as R-13.

## 7. Failure cases that would make Cortex misleading, unsafe, or unusable

Ranked by how badly they damage the mission:

1. **A trace that looks healthy but isn't.** The worst failure mode Cortex has. See the
   confirmed truncation evidence in §8 — a truncated call returns HTTP 200, a success
   status, and a plausible-but-wrong answer. Debugging that trace would wrongly blame the
   prompt for a harness fault, which is the exact inverse of the mission.
2. **Silent truncation** dropping the *start* of a prompt, where system instructions and
   output-format contracts live.
3. **Fallback laundering a prompt defect into an availability event** (§6.4).
4. **Persisting secrets** into the trace store (§6.3).
5. **Wrong-but-plausible NDCG** — a ranking metric that is subtly wrong is worse than none,
   because it will be trusted.
6. **Metrics that disagree with traces** — the dashboard is only as good as the record.
7. **Lost or duplicated work** on machine sleep.
8. **Priority starvation** in either direction.

## 8. Confirmed Generation 0 evidence: the floor cannot be read from the provider

The mission's context-window floor (O-6) depends on knowing each provider's *effective*
window. Generation 0 probed this rather than assuming it.

`ollama show` advertises **131072** tokens for `llama3.2:3b`. A needle-at-start probe of
~10,500 tokens returned `prompt_eval_count: 4096` — the prompt was silently truncated to
Ollama's default `num_ctx`, the needle was dropped, and the model answered incorrectly with
**no error and HTTP 200**. Re-running with explicit `options.num_ctx=16384` evaluated all
12,052 tokens and answered correctly.

Full evidence: `.mde/evidence/GEN-000-ollama-silent-truncation.md`

Two conclusions:

- **Advertised capability is not effective capability.** A floor computed from `ollama show`
  would be wrong by 32x and would pass overflowing prompts through.
- **This is a known, already-paid-for lesson.** `local_llm/src/local_llm/config.py:16`
  already pins `num_ctx: 16384` with the comment that Ollama's default "silently truncates
  longer prompts, which dropped Control Center's routing/question context." The same bug has
  now cost engineering time in two projects. It is being promoted to a central MDE issue
  signature so a third project does not rediscover it.

Design consequence: Cortex must (a) set `num_ctx` explicitly per call from the client's
declared floor, (b) assert `prompt_eval_count` matches what it intended to send, and
(c) record *evaluated* tokens in the trace, not just *sent* tokens. Note also that the
existing wrapper's 16384 is a **fixed global**: a client declaring 32k through that wrapper
would be silently truncated again unless Cortex passes `num_ctx` per request.

## 9. Contract questions the mission leaves open

- **Duplicate paths:** a "call" is defined as a job of size 1 (MISSION.md:23 — "a job is
  decomposed into its constituent calls internally; a call is the unit of execution"). To
  avoid two lifecycles that drift, submit-call should create the *same* lifecycle object as
  submit-job with one call, differing only in priority class. One queue, one trace model.
- **Correction/override paths:** traces are persistent records. The mission does not say
  whether a trace can be deleted or redacted after the fact. Retention is unbounded as
  written. Flagged in the risk register (R-11).
- **Canonical status location:** queue depth / provider health must appear in one canonical
  place before being repeated across screens.
- **Fairness floor is unquantified:** "jobs still make progress rather than starving"
  (MISSION.md:62) has no number. Generation 0 proposes making this explicit and testable
  rather than aspirational — see OQ-4.

## 10. Open questions for Ferosh (decision required)

| ID | Question | Why it blocks |
|---|---|---|
| **OQ-1** | Is Cortex **local-first** (local primary, cloud for burst/overflow) or **cloud-first** (Gemini -> OpenRouter -> local, matching today's live Command Center config)? | Changes latency contract, cost posture, the context-window floor, and which scenarios are Critical. MISSION.md:45 and :32 currently contradict each other. |
| **OQ-2** | Should the Command Center's operator-blocking routing call become submit-and-retrieve, or keep a bounded synchronous wait against Cortex? | The mission says submit-and-retrieve for all callers, but that path currently blocks the operator UI. This is a real UX change to a project Cortex may not edit. |
| **OQ-3** | Does "full input capture" mean the exact provider payload (post-redaction)? Confirm Cortex must never persist pre-redaction caller state. | Defines the trace schema and prevents the trace store becoming a credential store. |
| **OQ-4** | What is the fairness floor — e.g. "a queued job-call runs at least every N seconds / at least 1 in every M dispatches, even under continuous call load"? | "Jobs must not starve" is untestable without a number; a named Critical scenario depends on it. |
| **OQ-5** | Is the evaluation-reports requirement really **NDCG**, or is it **calibrated relevance judgment / a second independent evaluator**? | `ecommmerce-eval`'s `BDD-012` ("independent evaluator calibration produces similar findings") is deferred pending a second evaluator, and `VAL-DEFER-011-004` says scoring "remains bounded public-evidence judgment rather than a calibrated relevance benchmark". Cortex-as-LLM-judge plausibly closes both — but calibration is an *agreement* requirement that NDCG alone does not satisfy. This changes what "correct" means. |
| **OQ-6** | Does Generation 1 scope include a **handoff to `ecommmerce-eval`** to capture 10+ candidates and stable product IDs? | Without it the mission's first live use case (MISSION.md:37) cannot run. Cortex may not make the change itself (MISSION.md:48). |

Two further items are **recommendations, not questions** — flagged for awareness, no decision needed:

- Relevance grading scale: propose **0-3 graded** with `retail-search`'s default `graded`
  gain (2^g − 1), the conventional pairing. Nothing in `ecommmerce-eval` currently constrains
  it, so this is an open design choice rather than a discovered requirement.
- `retail-search` should be registered in the central portfolio before Cortex depends on it.

These are recorded as `type: decision` in `.mde/control-center-report.jsonl` with options.

## 11. Anti-Demo statement for this project

Cortex has almost no "screen work" that could pass as done while being a shell — but it has
a subtler equivalent, and the Anti-Demo Gate is aimed at it:

> A Cortex scenario is invalid if it can pass while the trace is incomplete, the tokens are
> unverified, or the provider was mocked at the wrong layer.

Specifically, provider-fallback and context-floor scenarios must be exercised against a
**real local Ollama** (which demonstrably lies about its window) or a mock that reproduces
the *observed* silent-truncation behaviour. A mock provider that politely raises
`ContextWindowExceeded` would let every context-floor BDD pass while the real system
silently truncates — a demo shell in the only place that matters.
