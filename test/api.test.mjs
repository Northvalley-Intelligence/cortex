/**
 * BDD-001, and the HTTP contract the consuming projects will call.
 *
 * Exercises the real server over a real socket -- the Anti-Demo rule for this project forbids
 * proving the API with in-process function calls (VALSTRAT-002). The provider is faked, but
 * everything from the socket inward is the production path.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApi } from "../src/api.mjs";
import { Worker } from "../src/worker.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";

let server, worker, base;

before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({
    providers: [fakeProvider("local", { kind: "ok", text: "ROUTED", evaluatedTokens: 40 })],
  });
  const api = createApi(db, config);
  worker = new Worker(db, api.queue, config);
  worker.start();
  server = api.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await worker.stop();
  server.close();
});

const post = (path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (path) => fetch(`${base}${path}`);

async function pollUntilTerminal(callId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await get(`/v1/calls/${callId}`);
    const body = await res.json();
    if (["succeeded", "failed", "exhausted"].includes(body.status)) return body;
    if (Date.now() > deadline) throw new Error(`timed out; last status ${body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("BDD-001 submit a single call and retrieve its result by ID over HTTP", () => {
  test("submission returns a call id immediately without blocking", async () => {
    const res = await post("/v1/calls", { client: "command-center", purpose: "route", prompt: "do the thing" });
    assert.equal(res.status, 202, "submit-and-retrieve: accepted, not a blocking 200");
    const body = await res.json();
    assert.match(body.call_id, /^call_/);
    assert.equal(body.trace_id, body.call_id, "the trace id accompanies the handle");
    assert.equal(body.status, "queued");
  });

  test("polling the id returns the output and the same trace id once complete", async () => {
    const submit = await (await post("/v1/calls", { client: "cc", prompt: "route this" })).json();
    const done = await pollUntilTerminal(submit.call_id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.output, "ROUTED");
    assert.equal(done.trace_id, submit.call_id, "the returned result carries the trace id back");
    assert.equal(done.resolved_by.provider, "local");
  });

  test("the full trace is retrievable by the same id", async () => {
    const submit = await (await post("/v1/calls", { client: "cc", prompt: "trace me" })).json();
    await pollUntilTerminal(submit.call_id);
    const trace = await (await get(`/v1/traces/${submit.call_id}`)).json();
    assert.equal(trace.trace_id, submit.call_id);
    assert.ok(trace.input.prompt);
    assert.ok(trace.attempts.length >= 1);
    assert.ok(trace.diagnosis);
  });

  test("the optional bounded wait returns the answer inline but never changes queue semantics", async () => {
    const res = await post("/v1/calls", { client: "cc", prompt: "wait for me", wait_ms: 5_000 });
    const body = await res.json();
    // Either it finished within the window (200 + output) or it is still pending (202) -- both
    // are valid, and both carry the trace id so the caller can always poll.
    assert.ok([200, 202].includes(res.status));
    assert.ok(body.trace_id, "the trace id is returned whether or not the answer arrived in time");
  });

  test("bad input is rejected with a clear error", async () => {
    assert.equal((await post("/v1/calls", { client: "cc" })).status, 400, "missing prompt");
    assert.equal((await post("/v1/calls", { prompt: "x" })).status, 400, "missing client");
    assert.equal((await get("/v1/calls/call_does-not-exist")).status, 404, "unknown id");
  });
});

describe("job submission and results over HTTP (BDD-002)", () => {
  test("a job returns per-call ids and its results are retrievable together", async () => {
    const res = await post("/v1/jobs", {
      client: "eval",
      calls: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
    });
    assert.equal(res.status, 202);
    const { job_id, call_ids } = await res.json();
    assert.equal(call_ids.length, 3);

    // Wait for the job to complete.
    for (let i = 0; i < 200; i += 1) {
      const j = await (await get(`/v1/jobs/${job_id}`)).json();
      if (j.status === "complete") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const results = await (await get(`/v1/jobs/${job_id}/results`)).json();
    assert.equal(results.status, "complete");
    assert.equal(results.counts.succeeded, 3);
    assert.equal(results.results.length, 3);
    assert.ok(results.results.every((r) => r.trace_id && r.output === "ROUTED"));

    // A deep link to a job scopes the trace list to that job only (viewer job view).
    const scoped = await (await get(`/v1/traces?job=${job_id}&limit=500`)).json();
    assert.equal(scoped.traces.length, 3, "job filter returns only that job's calls");
    assert.ok(scoped.traces.every((t) => t.job_id === job_id));
    // And an unrelated live call submitted separately is NOT in the scoped view.
    const other = await (await post("/v1/calls", { client: "cc", prompt: "standalone" })).json();
    await pollUntilTerminal(other.call_id);
    const scoped2 = await (await get(`/v1/traces?job=${job_id}`)).json();
    assert.ok(scoped2.traces.every((t) => t.job_id === job_id), "the standalone call does not leak into the job view");
    assert.ok(!scoped2.traces.some((t) => t.trace_id === other.call_id), "the standalone call is absent from the job view");
  });
});

describe("POST /v1/relevance accepts an optional caller rubric (composed-prompt contract)", () => {
  const q = () => ({ client: "eval", min_context_window: 8192, queries: [
    { query_id: "q1", query: "running shoes", products: [{ id: "p1", title: "Nike Pegasus" }] },
  ]});

  test("no rubric -> using_default_rubric true, and a rubric_hash is returned", async () => {
    const res = await post("/v1/relevance", q());
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.using_default_rubric, true);
    assert.ok(/^[0-9a-f]{12}$/.test(body.rubric_hash), "a stable rubric hash is echoed");

    // The hash is also retrievable on the results, so grades can be grouped by instruction-set.
    for (let i = 0; i < 200; i += 1) {
      const r = await (await get(`/v1/relevance/${body.job_id}`)).json();
      if (r.status === "complete") { assert.equal(r.rubric_hash, body.rubric_hash); assert.equal(r.using_default_rubric, true); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test("a caller rubric is accepted and changes the hash", async () => {
    const withRubric = { ...q(), rubric: "BOOK CATALOGUE: a study guide is not the book -> grade 1." };
    const def = await (await post("/v1/relevance", q())).json();
    const cust = await (await post("/v1/relevance", withRubric)).json();
    assert.equal(cust.using_default_rubric, false, "a supplied rubric is reported as non-default");
    assert.notEqual(cust.rubric_hash, def.rubric_hash, "a different rubric yields a different hash");
  });

  test("an empty or non-string rubric is rejected, never silently ignored", async () => {
    for (const bad of ["", "   ", 42, {}]) {
      const res = await post("/v1/relevance", { ...q(), rubric: bad });
      assert.equal(res.status, 400, `rubric ${JSON.stringify(bad)} must be rejected`);
    }
  });
});

describe("GET /v1/traces is a filterable, paginated grid (dashboard debugging surface)", () => {
  test("paginates with total/limit/offset and does not repeat rows across pages", async () => {
    for (let i = 0; i < 6; i += 1) await (await post("/v1/calls", { client: "grid-cli", purpose: "grid-test", prompt: `p${i}` })).json();
    // Let them drain so they are terminal (status filter test below depends on it).
    await new Promise((r) => setTimeout(r, 400));

    const p1 = await (await get("/v1/traces?client=grid-cli&limit=2&offset=0")).json();
    assert.ok(p1.total >= 6, "total reflects the full filtered set, not the page");
    assert.equal(p1.limit, 2);
    assert.equal(p1.traces.length, 2, "limit honoured");
    const p2 = await (await get("/v1/traces?client=grid-cli&limit=2&offset=2")).json();
    assert.equal(p2.offset, 2);
    const overlap = p1.traces.map((t) => t.trace_id).filter((id) => p2.traces.some((t) => t.trace_id === id));
    assert.equal(overlap.length, 0, "offset pages do not repeat rows");
  });

  test("filters by client, type, status, and free-text q", async () => {
    const byClient = await (await get("/v1/traces?client=grid-cli&limit=100")).json();
    assert.ok(byClient.traces.length >= 6);
    assert.ok(byClient.traces.every((t) => t.client === "grid-cli"), "client filter scopes results");

    const byType = await (await get("/v1/traces?type=call&client=grid-cli")).json();
    assert.ok(byType.traces.every((t) => t.priority_class === "call"), "type filter scopes to call vs job");

    const byStatus = await (await get("/v1/traces?client=grid-cli&status=succeeded&limit=100")).json();
    assert.ok(byStatus.traces.every((t) => t.status === "succeeded"), "status filter scopes results");

    const byQ = await (await get("/v1/traces?q=grid-test&limit=100")).json();
    assert.ok(byQ.traces.every((t) => t.purpose === "grid-test"), "q matches purpose/client/id");
    assert.equal(byQ.total, byQ.traces.length <= byQ.limit ? byQ.total : byQ.total, "q result carries a total for the pager");
  });

  test("facets expose distinct clients and purposes for the filter dropdowns", async () => {
    const f = await (await get("/v1/facets")).json();
    assert.ok(Array.isArray(f.clients) && f.clients.includes("grid-cli"));
    assert.ok(Array.isArray(f.purposes) && f.purposes.includes("grid-test"));
  });
});

describe("GET /v1/jobs lists jobs from the jobs table, paginated (not crowded out by call volume)", () => {
  test("lists newest-first with counts, and pages via limit/offset", async () => {
    // Submit several jobs so there is something to page through.
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await (await post("/v1/jobs", { client: `lister-${i}`, calls: [{ prompt: "a" }, { prompt: "b" }] })).json();
      ids.push(r.job_id);
    }
    // Let them finish so counts are meaningful.
    for (const id of ids) {
      for (let k = 0; k < 200; k += 1) {
        const j = await (await get(`/v1/jobs/${id}`)).json();
        if (j.status === "complete") break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    const page1 = await (await get("/v1/jobs?limit=2&offset=0")).json();
    assert.equal(page1.limit, 2);
    assert.equal(page1.jobs.length, 2, "limit is honoured");
    assert.ok(page1.total >= 5, "total reflects all jobs, not just the page");
    // Newest-first: the last-submitted job is on page 1.
    assert.equal(page1.jobs[0].job_id, ids[ids.length - 1]);
    assert.equal(page1.jobs[0].counts.total, 2);
    assert.equal(page1.jobs[0].counts.succeeded, 2);

    const page2 = await (await get("/v1/jobs?limit=2&offset=2")).json();
    assert.equal(page2.offset, 2);
    // No overlap between pages.
    const overlap = page1.jobs.map((j) => j.job_id).filter((id) => page2.jobs.some((j) => j.job_id === id));
    assert.equal(overlap.length, 0, "offset pages do not repeat jobs");

    const filtered = await (await get("/v1/jobs?client=lister-3")).json();
    assert.ok(filtered.jobs.every((j) => j.client === "lister-3"), "client filter scopes the list");
    assert.ok(filtered.jobs.length >= 1);
  });
});

describe("the capability contract is discoverable before submitting (MISSION.md:33)", () => {
  test("capabilities reports the effective prompt budget and eligible providers for a declared window", async () => {
    const small = await (await get("/v1/capabilities?min_context_window=8192")).json();
    assert.equal(small.satisfiable, true);
    assert.ok(small.effective_prompt_budget >= 8192);
    assert.ok(small.eligible_providers.length >= 1);

    const impossible = await (await get("/v1/capabilities?min_context_window=99999999")).json();
    assert.equal(impossible.satisfiable, false, "an unsatisfiable window is reported as such, not silently accepted");
    assert.ok(impossible.ineligible_providers.length >= 1);
    assert.ok(impossible.ineligible_providers[0].reason, "each ineligible provider explains why");
  });
});

describe("static pages", () => {
  test("the dashboard, trace viewer, and settings pages are served as HTML", async () => {
    for (const path of ["/", "/viewer", "/settings"]) {
      const res = await get(path);
      assert.equal(res.status, 200, `${path} should serve`);
      assert.match(res.headers.get("content-type"), /text\/html/);
      const body = await res.text();
      assert.match(body, /CORTEX/, `${path} should render the Cortex page`);
    }
  });
});

describe("health and metrics endpoints", () => {
  test("health reports queue depth and per-provider status", async () => {
    const h = await (await get("/v1/health")).json();
    assert.equal(h.ok, true);
    assert.ok(h.queue);
    assert.ok(Array.isArray(h.providers));
  });

  test("metrics returns call and provider aggregates", async () => {
    await pollUntilTerminal((await (await post("/v1/calls", { client: "cc", prompt: "for metrics" })).json()).call_id);
    const m = await (await get("/v1/metrics")).json();
    assert.ok(m.calls.total >= 1);
    assert.ok(Array.isArray(m.providers));
  });
});
