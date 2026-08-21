/**
 * Judgment cache: deterministic relevance judgments are served from a prior grade instead of a
 * 60s+ model call. The risk this guards (MISSION.md:93) is a stale confident number, so the
 * tests focus on key correctness -- a change to prompt, rubric, params, or model must MISS --
 * and on provenance (a served grade still points at the trace that produced it).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApi } from "../src/api.mjs";
import { Worker } from "../src/worker.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";
import {
  computeJudgmentKey, lookupJudgment, storeJudgment, clearJudgmentCache,
  judgmentCacheStats, judgeModelScope,
} from "../src/cache.mjs";

describe("cache key is sensitive to everything that changes the grade", () => {
  const base = { prompt: "Search query: x\nProduct title: y", systemPrompt: "FRAME + rubric", params: { temperature: 0, maxTokens: 120 }, modelScope: "local:llama3.2:3b" };

  test("identical inputs -> identical key", () => {
    assert.equal(computeJudgmentKey(base), computeJudgmentKey({ ...base }));
  });
  test("param key order does not change the key (stable stringify)", () => {
    const a = computeJudgmentKey({ ...base, params: { temperature: 0, maxTokens: 120 } });
    const b = computeJudgmentKey({ ...base, params: { maxTokens: 120, temperature: 0 } });
    assert.equal(a, b);
  });
  for (const [field, changed] of [
    ["prompt", { prompt: "different product" }],
    ["systemPrompt (rubric)", { systemPrompt: "FRAME + DIFFERENT rubric" }],
    ["params", { params: { temperature: 0, maxTokens: 200 } }],
    ["modelScope", { modelScope: "local:qwen3:4b" }],
  ]) {
    test(`a change to ${field} -> different key (cache correctly misses)`, () => {
      assert.notEqual(computeJudgmentKey(base), computeJudgmentKey({ ...base, ...changed }));
    });
  }

  test("judgeModelScope changes when the configured judge model changes", () => {
    const a = judgeModelScope(loadConfig({ providers: [fakeProvider("local", { kind: "ok" }, { model: "llama3.2:3b" })] }));
    const b = judgeModelScope(loadConfig({ providers: [fakeProvider("local", { kind: "ok" }, { model: "qwen3:4b" })] }));
    assert.notEqual(a, b, "a model swap must invalidate the cache");
  });
});

describe("store/lookup preserves provenance and never fabricates", () => {
  test("a stored judgment is looked up with its grade, reason, and source trace", () => {
    const db = openDb(":memory:");
    storeJudgment(db, { key: "k1", grade: 3, reason: "exact", sourceTraceId: "call_abc", model: "llama3.2:3b", now: 1000 });
    const hit = lookupJudgment(db, "k1");
    assert.equal(hit.grade, 3);
    assert.equal(hit.reason, "exact");
    assert.equal(hit.source_trace_id, "call_abc", "a cached grade stays auditable to its origin trace");
    assert.equal(lookupJudgment(db, "missing"), null);
  });

  test("write is idempotent (INSERT OR IGNORE): repeated store does not clobber or double the hit count", () => {
    const db = openDb(":memory:");
    storeJudgment(db, { key: "k", grade: 2, reason: "first", sourceTraceId: "t1", now: 1 });
    storeJudgment(db, { key: "k", grade: 0, reason: "SHOULD NOT OVERWRITE", sourceTraceId: "t2", now: 2 });
    const hit = lookupJudgment(db, "k");
    assert.equal(hit.grade, 2, "the first stored grade wins; a re-poll cannot rewrite it");
    assert.equal(hit.reason, "first");
  });

  test("lookup records hits; stats and clear work", () => {
    const db = openDb(":memory:");
    storeJudgment(db, { key: "k", grade: 1, reason: "r", sourceTraceId: "t", now: 1 });
    lookupJudgment(db, "k"); lookupJudgment(db, "k");
    const s = judgmentCacheStats(db);
    assert.equal(s.entries, 1);
    assert.equal(s.total_hits, 2);
    assert.equal(clearJudgmentCache(db), 1);
    assert.equal(judgmentCacheStats(db).entries, 0);
  });
});

describe("end-to-end over HTTP: a repeated relevance batch is served from cache", () => {
  let server, worker, base;
  before(async () => {
    const db = openDb(":memory:");
    // Fake judge returns a valid, parseable judgment so write-through happens.
    const config = loadConfig({ providers: [fakeProvider("local", { kind: "ok", text: '{"grade": 3, "reason": "match"}', evaluatedTokens: 40 })] });
    const api = createApi(db, config);
    worker = new Worker(db, api.queue, config);
    worker.start();
    server = api.server;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await worker.stop(); server.close(); });

  const submit = (extra = {}) => fetch(`${base}/v1/relevance`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "eval", min_context_window: 8192, k: 1,
      queries: [{ query_id: "q1", query: "1/2-in screw", products: [{ id: "p1", title: "1/2 in. Wood Screw" }] }], ...extra }),
  }).then((r) => r.json());

  const waitComplete = async (jobId) => {
    for (let i = 0; i < 200; i += 1) {
      const r = await (await fetch(`${base}/v1/relevance/${jobId}`)).json();
      if (r.status === "complete") return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error("job did not complete");
  };

  test("first run judges fresh; an identical second run is fully served from cache with 0 model calls", async () => {
    const first = await submit();
    assert.equal(first.cache.hits, 0, "first time is all misses");
    assert.equal(first.cache.misses, 1);
    const r1 = await waitComplete(first.job_id);
    assert.equal(r1.queries[0].judgments[0].grade, 3);
    assert.equal(r1.queries[0].judgments[0].from_cache, false, "the first grade is freshly judged");

    // Identical request now hits the cache written through on the first poll.
    const second = await submit();
    assert.equal(second.cache.hits, 1, "the repeat is served from cache");
    assert.equal(second.cache.misses, 0);
    assert.equal(second.status, "complete", "a fully-cached batch is complete immediately, no calls to run");
    const r2 = await waitComplete(second.job_id);
    const j = r2.queries[0].judgments[0];
    assert.equal(j.grade, 3, "the cached grade matches");
    assert.equal(j.from_cache, true, "and is marked as served from cache");
    assert.equal(j.trace_id, r1.queries[0].judgments[0].trace_id, "provenance points back to the original judgment's trace");
  });

  test("clearing the cache is its own endpoint, separate from trace pruning", async () => {
    await submit();                                   // ensure something is cached
    // Prune no longer accepts a cache flag — that path is traces-only now.
    const pruneCache = await fetch(`${base}/v1/admin/prune`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cache: true }),
    });
    assert.equal(pruneCache.status, 400, "prune rejects a cache flag; clearing the cache is a distinct action");

    // The dedicated endpoint clears it and reports how many entries were removed.
    const cleared = await (await fetch(`${base}/v1/admin/cache/clear`, { method: "POST" })).json();
    assert.ok(cleared.cleared_cache_entries >= 1, "the cache clear reports the count removed");

    // After clearing, the same request is a MISS again (re-judged), proving traces were untouched
    // but the cache was emptied.
    const after = await submit();
    assert.equal(after.cache.hits, 0, "cleared cache => next identical request is a miss");
  });

  test("fresh:true bypasses the cache and re-judges", async () => {
    await submit();                                   // ensure it is cached
    const bypass = await submit({ fresh: true });
    assert.equal(bypass.cache.bypassed, true);
    assert.equal(bypass.cache.misses, 1, "fresh:true forces a real judgment even when cached");
    assert.equal(bypass.cache.hits, 0);
  });

  test("a different rubric misses the cache (no stale cross-rubric grade)", async () => {
    await submit();                                   // cache under default rubric
    const custom = await submit({ rubric: "COMPLETELY DIFFERENT CRITERIA: everything is irrelevant." });
    assert.equal(custom.cache.hits, 0, "a different rubric must not reuse the default-rubric grade");
    assert.equal(custom.rubric_hash && custom.cache.misses, 1);
  });
});
