/**
 * Regression tests for two silent-correctness bugs a third-person caller review found that
 * the original suite missed (because it only ever sent well-formed input):
 *
 *   HIGH-1: a typo'd field (e.g. `sytsem_prompt`) was dropped at the HTTP boundary before the
 *           normalize gate ran -- reintroducing the silent-system-prompt bug for real callers.
 *   HIGH-2: a missing `query_id` silently merged distinct queries into one fabricated NDCG.
 *
 * Both are exactly the "harness fault that looks like a data/prompt fault" the mission warns
 * about, so they get explicit, boundary-level coverage.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApi } from "../src/api.mjs";
import { Worker } from "../src/worker.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";

let server, worker, base, db;

before(async () => {
  db = openDb(":memory:");
  const config = loadConfig({ providers: [fakeProvider("local", { kind: "ok", text: "ok" })] });
  const api = createApi(db, config);
  worker = new Worker(db, api.queue, config);
  worker.start();
  server = api.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await worker.stop(); server.close(); });

const post = (path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("HIGH-1 a misspelled field is rejected at the HTTP boundary, never silently dropped", () => {
  test("POST /v1/calls with a typo'd system_prompt is a 400, not a silent drop", async () => {
    const res = await post("/v1/calls", { client: "cc", prompt: "hi", sytsem_prompt: "oops typo" });
    assert.equal(res.status, 400, "the typo must be caught, not accepted");
    const body = await res.json();
    assert.match(body.error, /unrecognised field|sytsem_prompt/, "the error names the offending field");
  });

  test("POST /v1/jobs with a typo'd field in a call is a 400", async () => {
    const res = await post("/v1/jobs", { client: "eval", calls: [{ prompt: "a", sytsem_prompt: "oops" }] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /unrecognised field|sytsem_prompt/);
  });

  test("a correctly-spelled system_prompt still flows through to the trace", async () => {
    const submit = await (await post("/v1/calls", { client: "cc", prompt: "hi", system_prompt: "SYS-HERE", wait_ms: 5000 })).json();
    const trace = await (await fetch(`${base}/v1/traces/${submit.trace_id}`)).json();
    assert.equal(trace.input.system_prompt, "SYS-HERE", "a valid system prompt is delivered, not dropped");
  });

  test("unknown top-level fields on /v1/calls are rejected (wait_ms and the known set remain allowed)", async () => {
    assert.equal((await post("/v1/calls", { client: "cc", prompt: "x", bogus: 1 })).status, 400);
    // wait_ms is a known field; it may return 200 (finished) or 202 (pending) but never 400.
    assert.notEqual((await post("/v1/calls", { client: "cc", prompt: "x", wait_ms: 10 })).status, 400, "known fields still work");
  });
});

describe("HIGH-2 a missing or duplicate query_id is rejected, never silently merged", () => {
  test("a query without query_id is a 400 (it is the NDCG join key)", async () => {
    const res = await post("/v1/relevance", {
      client: "eval",
      queries: [{ query: "red shoes", products: [{ id: "p1", title: "Red Running Shoe" }] }],
    });
    assert.equal(res.status, 400, "a missing join key must not be silently accepted");
    const body = await res.json();
    assert.match(body.error, /query_id/, "the error explains the join-key requirement");
  });

  test("two distinct queries missing query_id do NOT get merged into one fabricated score", async () => {
    // This is the exact live reproduction the reviewer found (mean_ndcg 0.613 from pooling).
    const res = await post("/v1/relevance", {
      client: "eval",
      queries: [
        { query: "red shoes", products: [{ id: "p1", title: "Red Shoe" }] },
        { query: "green hat", products: [{ id: "p2", title: "Green Hat" }] },
      ],
    });
    assert.equal(res.status, 400, "without query_ids the request is refused, not silently pooled");
  });

  test("duplicate query_ids are rejected", async () => {
    const res = await post("/v1/relevance", {
      client: "eval",
      queries: [
        { query_id: "q1", query: "a", products: [{ id: "p1", title: "A" }] },
        { query_id: "q1", query: "b", products: [{ id: "p2", title: "B" }] },
      ],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /duplicate query_id/);
  });

  test("a well-formed relevance request with distinct query_ids is accepted", async () => {
    const res = await post("/v1/relevance", {
      client: "eval",
      queries: [
        { query_id: "q1", query: "red shoes", products: [{ id: "p1", title: "Red Shoe" }] },
        { query_id: "q2", query: "green hat", products: [{ id: "p2", title: "Green Hat" }] },
      ],
    });
    assert.equal(res.status, 202, "valid input is accepted");
    assert.equal((await res.json()).call_ids.length, 2);
  });
});

describe("GAP-2 caller params that change output shape are forwarded, not silently dropped", () => {
  test("reasoningEffort and responseFormat reach the provider payload", async () => {
    const { callOpenAiCompatible } = await import("../src/providers/openai-compatible.mjs");
    // Intercept the fetch to inspect the outgoing body without a network call.
    const orig = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {}, model: "m" }) };
    };
    try {
      await callOpenAiCompatible({
        provider: { id: "gemini", baseUrl: "http://x/v1", model: "m", apiKeyEnv: "" },
        prompt: "p", systemPrompt: null,
        params: { reasoningEffort: "low", responseFormat: { type: "json_object" } },
      });
      assert.equal(sent.reasoning_effort, "low", "reasoning_effort is forwarded");
      assert.deepEqual(sent.response_format, { type: "json_object" }, "response_format is forwarded");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
