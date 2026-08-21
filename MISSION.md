# Mission: Cortex

## Mission

Cortex is the shared LLM execution service for Northvalley Intelligence projects. It accepts work from any project through an API — latency-sensitive calls and batched jobs — queues it, executes it against a local model when the machine is available or a paid API provider when appropriate, records the full input and output of every call, and makes results retrievable by the requesting project.

Cortex exists so that language-model capability becomes durable shared infrastructure — a reusable "brain" other projects call into — rather than logic re-implemented and re-instrumented inside each project. Done means a project can submit a job, get a traceable result back through the API, and inspect exactly what prompt produced what output.

## Why It Matters

The local LLM is already live inside the Command Center, but its usage is opaque. Metrics exist, but there is no record of what went into the model and what came out. When an answer is wrong, there is no way to tell whether the model failed or the prompt did, so prompts cannot be improved with evidence. "Don't blame the model, blame the prompt" only works if every input and output is captured.

Latency also shapes the design: even live calls take roughly a minute to answer. That makes a submit-and-retrieve model the right default for every caller, not just batch jobs — "live" means near-real-time and asynchronous, not blocking. Cortex should treat all work as queued jobs with status, so a slow local model degrades gracefully instead of hanging the calling project.

At the same time, LLM use is spreading beyond command parsing. The evaluation-reports project needs relevance scoring and NDCG computed over search terms and products. Rebuilding model access, queueing, and instrumentation separately in each project is wasteful and inconsistent. Cortex centralizes execution and traceability once, so every current and future project inherits both.

## Who Benefits

The primary beneficiary is Ferosh, operating and improving the projects: submitting jobs, retrieving results, and optimizing prompts from real input/output evidence. Secondary beneficiaries are the consuming projects — the Command Center (live command parsing) and the evaluation-reports project (live or batch relevance evaluation and NDCG) — and any future project that needs model capability without building its own integration.

## Scope

Cortex handles two kinds of work. A **call** is a single, latency-sensitive request that a project needs answered quickly — for example the Command Center parsing one live command. A **job** is an aggregate of calls packaged together and handed to Cortex for background execution — for example the evaluation-reports project submitting a batch of search-term/product evaluations. A job is decomposed into its constituent calls internally; a call is the unit of execution and of traceability. Because calls are needed quickly and jobs can wait, Cortex prioritizes calls over jobs: a waiting call is served ahead of queued batch-job work, while jobs make steady background progress and are not starved.

In scope for this Generation 0 (full service, per decision to define queue, provider abstraction, traceability, and API together):

- A submission API for both work types that returns a trace ID: a project submits a single call and receives a call ID, or submits a job (a batch of calls) and receives a job ID that resolves to its per-call IDs. The ID is the client's handle to the work.
- Priority scheduling: calls are scheduled ahead of job-calls so live requests are not stuck behind a large batch, with fairness so background jobs still advance.
- Asynchronous execution: calls and jobs are queued and run when the machine is on; a slow or offline machine defers work rather than losing it.
- Serialized processing: because a local model handles one call at a time and each takes about a minute, work that arrives while the model is busy waits in the queue and is served by priority then order (bounded concurrency only where a provider safely supports it), so nothing is dropped or run over the top of in-flight work.
- A provider abstraction so the same job can run against a local model or a paid API provider without the calling project changing.
- An ordered provider fallback policy: try Gemini first, fall back to OpenRouter when Gemini quota is exhausted, then fall back to the local model. The chain is configurable, and each attempt and switch is recorded in the trace.
- A client-facing capability contract: Cortex exposes a minimum context-window parameter (and related capability needs). Because a job may be routed to any provider in the chain, the effective prompt budget is the smallest context window among eligible handlers. Clients declare the context window they need; Cortex routes only to models that satisfy it and guarantees prompts stay within that floor. If a job's requirement cannot be met, it fails clearly rather than silently truncating.
- A highly user-friendly UI: a dashboard showing LLM usage and reliability metrics across every model and provider — volume, latency, success/failure and fallback rates, quota status, and cost where applicable — so model and prompt health is visible at a glance.
- Full traceability keyed by ID: every call records its input (prompt, parameters, model/provider, version) and its output (response, tokens, timing, status) under its trace ID. The client uses that ID to look up the exact input and output in Cortex — through the API or the UI — for debugging and prompt optimization. The trace ID is also returned alongside the output, so a client can correlate a received result back to its full trace at any time.
- Result retrieval through the API for consuming projects.
- A first live use case proving the path end to end: evaluation-reports submits search-term/product sets, Cortex returns relevance judgments and NDCG.
- Retrofit of the existing Command Center LLM usage onto Cortex so its calls become traceable.

Explicitly out of scope for now: a general model-training or fine-tuning pipeline, multi-user access control, and hosting the service off the local machine. The metrics-and-traces UI is in scope; broader app-style UI beyond usage, reliability, and trace inspection is not.

## Constraints

- Latency: even live calls take roughly a minute, so the API contract is submit-and-retrieve (async with job status) for all callers; blocking request/response is not assumed.
- Local-first: primary execution is a local model, so the service must tolerate the machine being off and resume cleanly.
- Provider-agnostic and durable: the capabilities Cortex builds — queueing, provider abstraction, traceability, API, metrics UI — must survive swapping the underlying model or moving to purchased API quota. No project should hard-depend on a specific model.
- Portable prompt budget: because routing is dynamic and the client does not control which provider handles a job, prompts must fit the smallest context window among eligible handlers. Context window is a client-selected parameter, not an assumption; Cortex enforces the floor rather than letting a longer-context model mask a prompt that would overflow a smaller one.
- Repository ownership (MDE): Cortex is its own repository and its own writable session. It must not edit consuming projects directly; the Command Center retrofit is coordinated through its own session or a handoff, not by Cortex writing into it.
- Summary-first operation (MDE): progress and results are reported as summaries with trace references, not raw dumps.

## Assumptions

- The local model is adequate for the near-term tasks (command parsing, relevance scoring) once prompts are optimized.
- Consuming projects can integrate against a simple submit/retrieve API contract.
- The evaluation-reports relevance/NDCG task can be expressed as batched jobs.
- Traceability storage can live locally alongside the service for now.
- These assumptions are provisional and are validated during Generation 0, not treated as settled.

## Success Criteria

- A project can submit a single call and get its result, or submit a job (batch of calls) and get a job identifier plus per-call results.
- A latency-sensitive call is served ahead of queued batch-job work; a large job does not block a waiting call, and jobs still make progress rather than starving.
- Calls and jobs submitted while the machine is off or busy are not lost; they execute when the machine is available.
- Every call and job returns a trace ID, and that ID retrieves the complete trace — input, output, model/provider, version, timing, and status — through the API or the UI. The ID also accompanies the returned output so a result can be traced back at any time.
- The evaluation-reports use case runs through Cortex: given search terms and products, relevance judgments and NDCG are produced and made available through the API.
- Command Center LLM calls run through Cortex and are traceable, with no loss of its current live behavior, using the submit-and-retrieve contract despite ~1-minute execution time.
- Switching between a local model and an API provider requires no change in a calling project.
- Using captured traces, a prompt can be identified as the cause of a bad output and revised — demonstrating the "blame the prompt, not the model" workflow.
- The provider fallback chain works end to end: when Gemini quota is exhausted, jobs continue on OpenRouter, then on the local model, with each fallback visible in the trace and no caller change required.
- A client can declare a required context window and be guaranteed its prompts stay within that floor regardless of which provider runs the job; a job that cannot meet the requirement fails clearly instead of truncating.
- The UI presents usage and reliability metrics per model and provider (volume, latency, success/failure, fallback and quota status) clearly enough to spot an unreliable model or a failing prompt at a glance.
- Named scenarios exist and pass for each mission-critical workflow: live call under load, quota exhaustion mid-batch, machine sleep during a job, a prompt overflowing the smallest context window, and a trace lookup for a bad output.
- Before any human review, an agent inspects the screens and reports whether they are crowded, over-complicated, redundant, or unclear, and whether they actually show that the system is doing what it should — so review starts from a clean, self-checked state.

## Validation Direction

Feeding the Generation 0 Validation Strategy, the categories that matter most here are Functional Validation (call and job submitted, queued, executed, retrievable; calls served ahead of jobs without starving them; fallback chain Gemini to OpenRouter to local; NDCG correctness against a known reference), Technical Validation (durability across machine-off, provider swap without caller change, context-window floor enforced, trace completeness), Usability and UI Standards Validation (the metrics dashboard is genuinely easy to read and surfaces reliability problems quickly), and Mission Coverage Validation (traceability actually enables prompt debugging).

Validation is scenario-driven: concrete scenarios must be identified and tested, not just unit behaviors — the live call under load, quota exhaustion mid-batch, a machine sleep during a job, a prompt that overflows the smallest context window, a trace lookup for a bad output. Each mission-critical workflow carries named scenarios with expected outcomes.

Before Ferosh reviews the site, an agent first looks at the actual screens and judges them, so review time is spent on substance rather than obvious problems. This automated pre-review pass checks the handful of things Ferosh looks for: is the screen crowded, is it too complicated, is anything repeated or redundant, is the hierarchy clear, and — practically — do the screens actually show whether the system is doing what it is supposed to. This is also a real usability signal in its own right: because Cortex's screens are how Ferosh reads system state, a confusing screen is a genuine defect, not cosmetics. A Third-Person Validation Gate then independently checks the consuming-project experience — the Command Center and evaluation-reports as callers — for API-contract fit, failure modes when the machine is off or a provider is exhausted, whether the context-window contract holds under routing, and whether the UI and traces are genuinely useful for diagnosing a bad answer.

## Risks And Dependencies

- Async correctness: jobs lost, duplicated, or stuck when the machine sleeps or restarts. Mitigate with durable queue state and explicit job status.
- Contention and backlog: bursts of concurrent work against a one-at-a-time local model can build a long queue. Mitigate with serialized processing, visible queue position/status, and fair ordering; consider offloading to an API provider when backlog is unacceptable.
- Priority starvation: a steady stream of calls could indefinitely delay batch jobs, or a giant job could delay calls. Mitigate with call-over-job priority plus a fairness floor that guarantees jobs keep advancing.
- Trace integrity: partial or missing traces undermine the core mission. Traceability is a first-class requirement, not a log side-effect.
- Provider drift: local and API providers behaving differently for the same job, weakening the abstraction. Validate parity explicitly.
- Fallback correctness: not detecting Gemini quota exhaustion cleanly, or looping/stalling on failover to OpenRouter or local. Validate the chain and record each attempt.
- Context-window mismatch: a prompt sized for a large-context model silently overflowing a smaller handler after fallback. Mitigate by enforcing the client-declared floor and failing clearly instead of truncating.
- Metric integrity: usage and reliability numbers in the UI being wrong or misleading, causing bad model/prompt decisions. The UI is only as valuable as the traceability behind it.
- NDCG correctness: relevance scoring or ranking-metric errors producing plausible-but-wrong numbers. Validate against a known reference set.
- Cross-repo coordination: the Command Center retrofit depends on a separate session and must respect repository ownership boundaries.
- Downstream impact: because multiple projects will depend on Cortex, its API contract and availability become shared risk; changes require compatibility care.
