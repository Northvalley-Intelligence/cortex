# Goal Drift Review — Cortex GEN-000/GEN-001

**1. What supports the mission?**
Every component traces to a mission line: submit-and-retrieve API (O-1), trace store + diagnosis
(O-2, the mission's core "blame the prompt not the model"), durable leases (O-3), call-over-job
priority + fairness floor (O-4), provider chain + availability/content distinction (O-5),
context-window floor with real-provider truncation detection (O-6), metrics dashboard (O-7). All
five named scenarios are validated, and the highest-risk one (silent truncation) is proven against
the real model rather than a mock.

**2. What is missing?**
The first LIVE eval-reports NDCG use case does not yet run end-to-end — blocked upstream (only 8
candidates captured, no stable product IDs in ecommmerce-eval), which Cortex may not fix itself.
The NDCG path and math are validated in isolation. Broader LLM-judge variance (repeated-judgment
study) is shown only at single-run stability. Six design decisions (OQ-1..OQ-6) remain Ferosh's.

**3. What is over-engineered?**
Nothing built for scale it won't see: the ~10-call realistic job size (from the Gen-0 survey) was
used to explicitly REJECT 1000+ call load testing as over-engineering. Zero dependencies kept the
surface minimal. The redaction pass and secret-scan are proportionate to a real new risk (first
component to persist full LLM inputs), not speculative.

**4. What was deferred?**
Full OpenAI-compatible /chat/completions shim (GAP-1 — surfaced to Ferosh, not silently built);
per-call model/chain pinning (GAP-3); a rendered trace-detail UI page (UI-2, raw JSON is fine for
an internal tool); trace retention policy (R-11); the eval-reports live wiring (R-12/OQ-6).

**5. Are we still serving the mission?**
Yes. The build stayed inside scope (MISSION.md:40) — usage/reliability/trace UI only, no broader
app. It did NOT edit consuming projects (MISSION.md:48), expressing cross-repo work as HANDOFF.md.
The one place the mission contradicts itself (local-first vs cloud-first) was surfaced as OQ-1 with
a documented default rather than silently resolved. The temptation to "just wire up the Command
Center too" was resisted because that repo is not Cortex's to write.
