/**
 * POST /v1/search-eval - listwise search evaluation. No network, no paid calls: every provider
 * is a fake adapter that answers from the prompt it was actually sent.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApi } from "../src/api.mjs";
import { Worker } from "../src/worker.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";
import { ProviderError } from "../src/failures.mjs";
import { SEARCH_EVAL_OUTPUT_SCHEMA } from "../src/search-eval.mjs";
import { callAnthropic } from "../src/providers/anthropic.mjs";
import { SCORE_WEIGHTS, splitWindows, buildScorecard } from "../src/search-eval.mjs";

const idsIn = (prompt) => [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]);

/** A provider whose answer is built from the ids in the prompt. `answer(ids, prompt)` -> object. */
function answering(id, answer, overrides = {}) {
  const calls = [];
  const p = fakeProvider(id, { kind: "ok" }, {
    ...overrides,
    __adapter: async ({ provider, prompt, params }) => {
      calls.push({ prompt, params });
      return {
        text: JSON.stringify(answer(idsIn(prompt), prompt)),
        evaluatedTokens: 100, completionTokens: 20, requestedNumCtx: 32768,
        truncationDetected: false, providerVersion: provider.model, requestPayload: { model: provider.model, prompt },
      };
    },
  });
  return { provider: p, calls };
}

const verdict = (groups, extra = {}) => ({
  groups, first_useful_position: 1, ranking: "optimal", ranking_reason: "ok",
  task_guidance: "met", intent: "resolved", ...extra,
});
const allIn = (ids, grade) => verdict([{ group_id: "g1", item_ids: ids, grade, reason: "all" }]);
const singles = (ids, gradeOf) => ids.map((id, i) => ({ group_id: `g${i}`, item_ids: [id], grade: gradeOf(i), reason: "r" }));

const items = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, position: i + 1, type: "product", title: `Item ${i + 1}` }));
const search = (over = {}) => ({ search_id: "s1", query: "pizza stone", results: items(3), ...over });

let envs = [];
async function makeEnv(providers) {
  const db = openDb(":memory:");
  const config = loadConfig({ providers });
  const api = createApi(db, config);
  const worker = new Worker(db, api.queue, config);
  worker.start();
  await new Promise((r) => api.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const env = {
    db, base,
    post: (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    async submit(provider, searches, extra = {}) {
      const res = await env.post("/v1/search-eval", { client: "t", provider, rubric: "RUBRIC: grade by fit.", searches, ...extra });
      return { status: res.status, body: await res.json() };
    },
    async result(jobId) {
      for (let i = 0; i < 300; i += 1) {
        const r = await (await fetch(`${base}/v1/search-eval/${jobId}`)).json();
        if (r.status === "complete") return r;
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error("job did not complete");
    },
    async close() { await worker.stop(); api.server.close(); },
  };
  envs.push(env);
  return env;
}
afterEach(async () => { for (const e of envs) await e.close(); envs = []; });

describe("request validation", () => {
  test("missing rubric -> 400 naming rubric (never the hardware default); unknown provider -> 400; duplicate search_id -> 400", async () => {
    const { provider } = answering("local", (ids) => allIn(ids, 3));
    const env = await makeEnv([provider]);
    const noRubric = await env.post("/v1/search-eval", { client: "t", provider: "local", searches: [search()] });
    assert.equal(noRubric.status, 400);
    assert.match((await noRubric.json()).error, /rubric/);
    const badProvider = await env.submit("nope", [search()]);
    assert.equal(badProvider.status, 400);
    assert.match(badProvider.body.error, /unknown provider/);
    const noProvider = await env.post("/v1/search-eval", { client: "t", rubric: "r", searches: [search()] });
    assert.equal(noProvider.status, 400);
    const dup = await env.submit("local", [search(), search()]);
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /duplicate search_id/);
  });

  test("guidance_required rejects non-booleans before submitting any jobs", async () => {
    const { provider, calls } = answering("local", (ids) => allIn(ids, 3));
    const env = await makeEnv([provider]);
    for (const value of [null, "true", "false", 0, 1, [], {}]) {
      const bad = await env.submit("local", [
        search({ search_id: "valid" }), search({ guidance_required: value }),
      ]);
      assert.equal(bad.status, 400, `reject ${JSON.stringify(value)}`);
      assert.deepEqual(bad.body, { error: "searches[1].guidance_required must be a boolean" });
    }
    assert.equal(env.db.prepare("SELECT COUNT(*) n FROM jobs").get().n, 0);
    assert.equal(env.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 0);
    assert.equal(calls.length, 0);
  });

  test("duplicate result id, bad type and a private image host are rejected", async () => {
    const { provider } = answering("local", (ids) => allIn(ids, 3));
    const env = await makeEnv([provider]);
    const dupId = await env.submit("local", [search({ results: [items(1)[0], items(1)[0]] })]);
    assert.equal(dupId.status, 400);
    const badType = await env.submit("local", [search({ results: [{ ...items(1)[0], type: "gadget" }] })]);
    assert.equal(badType.status, 400);
    const privateImg = await env.submit("local", [search({ results: [{ ...items(1)[0], image_url: "http://127.0.0.1/x.png" }] })]);
    assert.equal(privateImg.status, 400);
  });
});

describe("grading and scorecard", () => {
  test("size variants returned in one group get identical grades, aligned by id", async () => {
    const { provider } = answering("local", (ids) => verdict([
      { group_id: "g1", item_ids: [ids[0], ids[1]], grade: 3, reason: "same product, two sizes" },
      { group_id: "g2", item_ids: [ids[2]], grade: 1, reason: "other" },
    ]));
    const env = await makeEnv([provider]);
    const { body } = await env.submit("local", [search()]);
    const r = await env.result(body.job_id);
    const got = r.searches[0].items;
    assert.equal(got[0].grade, got[1].grade);
    assert.equal(got[0].group_id, got[1].group_id);
    assert.deepEqual(got.map((i) => [i.id, i.grade]), [["p1", 3], ["p2", 3], ["p3", 1]]);
  });

  test("head complete: ranking points are 20 even when the model says minor, coverage is 30", async () => {
    const { provider } = answering("local", (ids) => verdict(
      singles(ids, (i) => (i < 3 ? 3 : 0)),
      { ranking: "minor", task_guidance: "not_needed" },
    ));
    const env = await makeEnv([provider]);
    const { body } = await env.submit("local", [search({ results: items(10), applicable_ids: ["p1", "p2", "p3"] })]);
    const s = (await env.result(body.job_id)).searches[0];
    assert.equal(s.head_complete, true);
    assert.equal(s.coverage, 1);
    // first 30 + coverage 30 + ranking 20 (floor, not minor's 12) + effort 10 = 90/90 -> 100.
    assert.equal(s.score_0_100, 100);
  });

  test("requirement violation: applicable item at position 3, model says major -> ranking 0", async () => {
    const { provider } = answering("local", (ids) => verdict(
      singles(ids, (i) => (i === 2 ? 3 : 0)),
      { ranking: "major", task_guidance: "missing" },
    ));
    const env = await makeEnv([provider]);
    const { body } = await env.submit("local", [search({ applicable_ids: ["p3"] })]);
    const s = (await env.result(body.job_id)).searches[0];
    assert.equal(s.head_complete, false);
    assert.equal(s.first_useful_position, 3);
    // first (pos 3) 20 + coverage 30 + ranking 0 + effort 10 + guidance 0.
    assert.equal(s.score_0_100, 60);
    assert.equal(SCORE_WEIGHTS.ranking_points.major, 0);
  });

  test("unresolved intent -> score null and counted in unresolved, not in the mean", async () => {
    const { provider } = answering("local", (ids, prompt) => (prompt.includes("Search term: unclear")
      ? { ...allIn(ids, 0), intent: "unresolved" }
      : allIn(ids, 3)));
    const env = await makeEnv([provider]);
    const { body } = await env.submit("local", [
      search({ search_id: "a", query: "pizza stone" }), search({ search_id: "b", query: "unclear" }),
    ]);
    const r = await env.result(body.job_id);
    const byId = Object.fromEntries(r.searches.map((s) => [s.search_id, s]));
    assert.equal(byId.b.score_0_100, null);
    assert.equal(typeof byId.a.score_0_100, "number");
    assert.equal(r.counts.unresolved, 1);
    assert.equal(r.findability_score, byId.a.score_0_100, "the mean covers only the non-null score");
  });
});

describe("failure handling", () => {
  test("a model that omits an item id fails the search and no grade is fabricated", async () => {
    const { provider } = answering("local", (ids) => allIn(ids.slice(0, -1), 3));
    const env = await makeEnv([provider]);
    const { body } = await env.submit("local", [search()]);
    const r = await env.result(body.job_id);
    assert.equal(r.searches[0].status, "failed");
    assert.equal(r.searches[0].items, undefined);
    assert.match(r.searches[0].errors[0].error, /omitted 1 result id/);
    assert.equal(r.counts.failed, 1);
    assert.equal(r.findability_score, null);
  });

  test("pinned provider unavailable -> exhausted, and no fall-through to another provider", async () => {
    const pinned = fakeProvider("pinned", { kind: "geminiQuota" });
    const { provider: other, calls: otherCalls } = answering("other", (ids) => allIn(ids, 3));
    const env = await makeEnv([pinned, other]);
    const { body } = await env.submit("pinned", [search()]);
    const r = await env.result(body.job_id);
    assert.equal(r.searches[0].status, "failed");
    const call = env.db.prepare(`SELECT status FROM calls WHERE id = ?`).get(body.call_ids[0]);
    assert.equal(call.status, "exhausted");
    const attempts = env.db.prepare(`SELECT provider_id FROM attempts WHERE call_id = ?`).all(body.call_ids[0]);
    assert.deepEqual(attempts.map((a) => a.provider_id), ["pinned"]);
    assert.equal(otherCalls.length, 0);
  });
});

describe("cache and windowing", () => {
  test("second identical submit is served from cache with 0 new calls", async () => {
    const { provider, calls } = answering("local", (ids) => allIn(ids, 3));
    const env = await makeEnv([provider]);
    const first = await env.submit("local", [search()]);
    assert.equal(first.body.cache.misses, 1);
    const r1 = await env.result(first.body.job_id);
    assert.equal(calls.length, 1);
    const second = await env.submit("local", [search()]);
    assert.equal(second.body.status, "complete");
    assert.equal(second.body.cache.hits, 1);
    assert.deepEqual(second.body.call_ids, []);
    const r2 = await env.result(second.body.job_id);
    assert.equal(calls.length, 1, "no new model call");
    assert.deepEqual(r2.searches[0].items, r1.searches[0].items);
    assert.equal(env.db.prepare(`SELECT COUNT(*) n FROM calls`).get().n, 1);
  });

  test("30 items with window 20 -> 2 calls (overlap 5), groups reconciled by id", async () => {
    assert.deepEqual(splitWindows(items(30), 20).map((w) => [w[0].id, w.length]), [["p1", 20], ["p16", 15]]);
    // p16 is in both windows; p25 only in window 2. They are variants of one product.
    const { provider, calls } = answering("local", (ids) => {
      const variants = ids.filter((i) => i === "p16" || i === "p25");
      const groups = singles(ids.filter((i) => !variants.includes(i)), () => 1).map((g) => ({ ...g, group_id: `g-${g.item_ids[0]}` }));
      if (variants.length) groups.push({ group_id: "v", item_ids: variants, grade: 3, reason: "variants" });
      return verdict(groups);
    });
    const env = await makeEnv([provider]);
    const { body } = await env.submit("local", [search({ results: items(30) })]);
    const r = await env.result(body.job_id);
    assert.equal(calls.length, 2);
    assert.equal(r.searches[0].windows, 2);
    assert.equal(r.searches[0].items.length, 30);
    const byId = Object.fromEntries(r.searches[0].items.map((i) => [i.id, i]));
    assert.equal(byId.p16.grade, 3);
    assert.equal(byId.p25.grade, 3, "p25 only appears in window 2 but joins the p16 variant group");
    assert.equal(byId.p16.group_id, byId.p25.group_id);
    assert.equal(r.searches[0].window_conflicts, 0);
  });
});

describe("anthropic adapter", () => {
  const provider = { id: "claude-haiku", kind: "anthropic", baseUrl: "https://api.anthropic.test", model: "claude-haiku-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" };

  test("request body has an image block when image_url is set; key is read from env, sent only as a header, never recorded", async () => {
    const realFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key-NOT-REAL-123456";
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ model: "claude-haiku-5-5", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: "end_turn" }), { status: 200 });
    };
    try {
      const out = await callAnthropic({
        provider, prompt: "grade", systemPrompt: "SYS",
        params: { maxTokens: 100, images: [{ id: "p1", url: "https://img.example.test/a.png" }] },
      });
      assert.equal(seen.url, "https://api.anthropic.test/v1/messages");
      assert.equal(seen.init.headers["x-api-key"], "test-key-NOT-REAL-123456");
      assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
      const body = JSON.parse(seen.init.body);
      assert.equal(body.system, "SYS");
      assert.ok(body.messages[0].content.some((b) => b.type === "image" && b.source.type === "url" && b.source.url === "https://img.example.test/a.png"));
      assert.equal(JSON.stringify(out.requestPayload).includes("test-key-NOT-REAL"), false, "key never reaches the recorded payload");
      assert.equal(out.text, "{}");

      await callAnthropic({ provider, prompt: "grade", systemPrompt: "SYS", params: {} });
      assert.equal(JSON.parse(seen.init.body).messages[0].content.some((b) => b.type === "image"), false, "no image_url -> no image block");

      globalThis.fetch = async () => new Response('{"error":{"type":"overloaded_error"}}', { status: 529 });
      await assert.rejects(callAnthropic({ provider, prompt: "g", params: {} }), (err) => {
        assert.equal(err.failureKind, "availability");
        assert.equal(err.message.includes("test-key-NOT-REAL"), false);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("a missing key is an availability failure; Anthropic providers are never in the fallback chain", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(callAnthropic({ provider, prompt: "g", params: {} }), (err) => err.failureKind === "availability");
    const config = loadConfig();
    assert.ok(!config.providers.some((p) => p.kind === "anthropic"), "paid models never join the chain");
    assert.deepEqual(config.pinnedProviders.map((p) => p.id), ["claude-haiku", "claude-sonnet", "local-vision"]);
  });

  const withFetch = async (reply, fn) => {
    const realFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key-NOT-REAL-123456";
    let seen;
    globalThis.fetch = async (url, init) => { seen = JSON.parse(init.body); return new Response(JSON.stringify(reply), { status: 200 }); };
    try { return await fn(() => seen); } finally { globalThis.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; }
  };
  const okReply = { model: "claude-haiku-5-5", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };

  test("body never has temperature/top_p/top_k; effort is passed through and defaults to medium; max_tokens defaults 16000", async () => {
    await withFetch(okReply, async (seen) => {
      const out = await callAnthropic({ provider, prompt: "g", params: { temperature: 0.7, top_p: 0.5, top_k: 3, effort: "high" } });
      assert.equal(out.text, "{}", "thinking blocks are ignored");
      for (const k of ["temperature", "top_p", "top_k"]) assert.equal(k in seen(), false);
      assert.deepEqual(seen().output_config, { effort: "high" });
      await callAnthropic({ provider, prompt: "g", params: {} });
      assert.deepEqual(seen().output_config, { effort: "medium" });
      assert.equal(seen().max_tokens, 16000);
    });
  });

  test("output_schema adds output_config.format next to effort; absent otherwise", async () => {
    await withFetch(okReply, async (seen) => {
      await callAnthropic({ provider, prompt: "g", params: { effort: "high", output_schema: SEARCH_EVAL_OUTPUT_SCHEMA } });
      assert.deepEqual(seen().output_config, { effort: "high", format: { type: "json_schema", schema: SEARCH_EVAL_OUTPUT_SCHEMA } });
      await callAnthropic({ provider, prompt: "g", params: { effort: "high" } });
      assert.equal("format" in seen().output_config, false);
    });
  });

  test("SEARCH_EVAL_OUTPUT_SCHEMA is strict at every level and accepts a known-good answer", () => {
    const check = (schema, v) => {
      const types = [].concat(schema.type);
      const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
      assert.ok(types.includes(t) || (t === "integer" && types.includes("number")), `type ${t} not in ${types}`);
      if (schema.enum) assert.ok(schema.enum.includes(v), `${v} not in enum`);
      if (t === "object") {
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
        assert.deepEqual(Object.keys(v).sort(), [...schema.required].sort());
        for (const k of schema.required) check(schema.properties[k], v[k]);
      }
      if (t === "array") v.forEach((x) => check(schema.items, x));
    };
    const good = {
      groups: [{ group_id: "g1", item_ids: ["a", "b"], grade: 3, reason: "exact" }, { group_id: "g2", item_ids: ["c"], grade: 0, reason: "off" }],
      first_useful_position: 1, ranking: "optimal", ranking_reason: "ok", task_guidance: "not_needed", intent: "resolved",
    };
    check(SEARCH_EVAL_OUTPUT_SCHEMA, good);
    check(SEARCH_EVAL_OUTPUT_SCHEMA, { ...good, first_useful_position: null });
    assert.throws(() => check(SEARCH_EVAL_OUTPUT_SCHEMA, { ...good, ranking: "bad" }));
  });

  test("search-eval route sends output_schema on every call; cache key still hits on repeat", async () => {
    const { provider: p, calls } = answering("local", (ids) => allIn(ids, 3));
    const env = await makeEnv([p]);
    const a = await env.submit("local", [search()]);
    await env.result(a.body.job_id);
    assert.deepEqual(calls[0].params.output_schema, SEARCH_EVAL_OUTPUT_SCHEMA);
    const b = await env.submit("local", [search()]);
    assert.equal(b.body.cache.hits, 1);
  });

  test("refusal is a content failure naming the category", async () => {
    await withFetch({ ...okReply, stop_reason: "refusal", stop_details: { category: "cyber" } }, async () => {
      await assert.rejects(callAnthropic({ provider, prompt: "g", params: {} }), (err) => {
        assert.equal(err.failureKind, "content");
        assert.match(err.message, /cyber/);
        return true;
      });
    });
  });

  test("invalid params.effort -> 400; valid effort reaches the adapter and changes the cache key", async () => {
    const { provider: p, calls } = answering("local", (ids) => allIn(ids, 3));
    const env = await makeEnv([p]);
    const bad = await env.submit("local", [search()], { params: { effort: "turbo" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /effort/);
    const hi = await env.submit("local", [search()], { params: { effort: "high" } });
    await env.result(hi.body.job_id);
    assert.equal(calls[0].params.effort, "high");
    const lo = await env.submit("local", [search()], { params: { effort: "low" } });
    assert.equal(lo.body.cache.hits, 0, "different effort is a different cache entry");
  });

  test("refusal ends the search as failed with no grade", async () => {
    const refusing = fakeProvider("local", { kind: "ok" }, {
      __adapter: async () => { throw new ProviderError("local: model refused (cyber)", { failureKind: "content", provider: "local" }); },
    });
    const env = await makeEnv([refusing]);
    const { body } = await env.submit("local", [search()]);
    const r = await env.result(body.job_id);
    assert.equal(r.searches[0].status, "failed");
    assert.equal(r.findability_score, null);
  });

  test("pinned Haiku pricing records cost: 1000 in / 1000 out = 0.0006 USD", async () => {
    const haiku = loadConfig().pinnedProviders.find((p) => p.id === "claude-haiku");
    const sonnet = loadConfig().pinnedProviders.find((p) => p.id === "claude-sonnet");
    assert.ok(Math.abs(haiku.costPer1kInputUsd + haiku.costPer1kOutputUsd - 0.0006) < 1e-12);
    assert.ok(Math.abs(sonnet.costPer1kInputUsd + sonnet.costPer1kOutputUsd - 0.012) < 1e-12);
    const local = fakeProvider("local", { kind: "ok" }, {
      __adapter: async ({ provider, prompt }) => ({
        text: JSON.stringify(allIn(idsIn(prompt), 3)), evaluatedTokens: 1000, completionTokens: 1000,
        requestedNumCtx: null, truncationDetected: false, providerVersion: provider.model, requestPayload: {},
      }),
    });
    local.costPer1kInputUsd = haiku.costPer1kInputUsd;
    local.costPer1kOutputUsd = haiku.costPer1kOutputUsd;
    const env = await makeEnv([local]);
    const { body } = await env.submit("local", [search()]);
    await env.result(body.job_id);
    const row = env.db.prepare(`SELECT cost_usd FROM attempts WHERE call_id = ?`).get(body.call_ids[0]);
    assert.ok(Math.abs(row.cost_usd - 0.0006) < 1e-9, `cost ${row.cost_usd}`);
  });
});

describe("grading guards (H16)", () => {
  for (const flag of [true, false, undefined]) {
    test(`API preserves guidance_required=${flag} for fresh and cached learning searches`, async () => {
      const { provider, calls } = answering("local", (ids) => allIn(ids, 3));
      const env = await makeEnv([provider]);
      const learningSearch = search({
        query: "learn to bake pizza",
        task: "Learn how to bake pizza using a pizza stone",
        ...(flag !== undefined ? { guidance_required: flag } : {}),
      });
      for (const cached of [false, true]) {
        const { status, body } = await env.submit("local", [learningSearch]);
        assert.equal(status, 202);
        assert.equal(body.cache.hits, cached ? 1 : 0);
        // Read the serialized job, not the submitted object: polling must survive normalization
        // and durable metadata round-tripping even when no new provider call is needed.
        const metadata = JSON.parse(env.db.prepare("SELECT metadata FROM jobs WHERE id = ?").get(body.job_id).metadata);
        assert.equal(metadata.searches[0].guidance_required, flag);
        assert.equal(Object.hasOwn(metadata.searches[0], "guidance_required"), flag !== undefined);
        const result = await env.result(body.job_id);
        const card = result.searches[0];
        assert.equal(card.status, "scored");
        assert.deepEqual(card.items.map((item) => item.grade), [3, 3, 3]);
        assert.equal(card.task_guidance, flag === true ? "missing" : "met");
        assert.equal(card.task_guidance_coerced === true, flag === true);
        assert.equal(card.score_0_100, flag === true ? 69 : 100);
        assert.equal(result.counts.works, flag === true ? 0 : 1);
      }
      assert.equal(calls.length, 1, "repeat uses the cached synthetic verdict");
    });
  }

  const AS_OF = "2026-06-01T00:00:00.000Z";
  const recon = (grades, over = {}) => ({
    byId: new Map(Object.entries(grades).map(([id, grade]) => [id, { group_id: `g-${id}`, grade, reason: "r" }])),
    conflicts: 0, ranking: "optimal", ranking_reason: null, task_guidance: "met", intent: "resolved",
    model_first_useful_position: 1, ...over,
  });
  const card = (results, grades, over, guidanceRequired, asOf = AS_OF) =>
    buildScorecard({ results, applicable: null, reconciled: recon(grades, over), asOf, guidanceRequired });
  const product = [{ id: "p1", position: 1, type: "product" }];

  test("A: met guidance with products only is coerced to missing and capped at 69", () => {
    const c = card(product, { p1: 3 }, {}, true);
    assert.equal(c.task_guidance, "missing");
    assert.equal(c.task_guidance_coerced, true);
    assert.equal(c.score_0_100, 69);
  });

  test("B: model-reported missing guidance is capped at 69, not coerced", () => {
    const c = card(product, { p1: 3 }, { task_guidance: "missing" }, true);
    assert.equal(c.score_0_100, 69);
    assert.ok(!c.task_guidance_coerced);
  });

  test("C: a past event is capped at grade 1 and does not satisfy guidance", () => {
    const c = card([{ id: "e1", position: 1, type: "event", event_date: "2026-01-15" }], { e1: 3 }, {}, true);
    assert.equal(c.items[0].grade, 1);
    assert.ok(c.items[0].reason.endsWith("[past event: 2026-01-15]"));
    assert.deepEqual(c.past_event_capped, ["e1"]);
    assert.equal(c.task_guidance, "missing");
    assert.equal(c.task_guidance_coerced, true);
  });

  test("D: a future event keeps its grade and satisfies guidance", () => {
    const c = card([{ id: "e1", position: 1, type: "event", event_date: "2026-12-15" }], { e1: 3 }, {}, true);
    assert.equal(c.items[0].grade, 3);
    assert.equal(c.past_event_capped, undefined);
    assert.equal(c.task_guidance, "met");
    assert.ok(!c.task_guidance_coerced);
  });

  test("E: unresolved intent with a useful item is scored and flagged ambiguous", () => {
    const c = card(product, { p1: 3 }, { intent: "unresolved", task_guidance: "not_needed" });
    assert.equal(typeof c.score_0_100, "number");
    assert.equal(c.ambiguous, true);
  });

  test("F: unresolved intent with nothing useful stays null", () => {
    const c = card(product, { p1: 1 }, { intent: "unresolved" });
    assert.equal(c.score_0_100, null);
  });

  test("G: not_needed guidance keeps the rescale path", () => {
    const c = card(product, { p1: 3 }, { task_guidance: "not_needed" });
    assert.equal(c.score_0_100, 100);
  });

  test("H: a graded guide satisfies guidance with no coercion or cap", () => {
    const c = card([{ id: "g1", position: 1, type: "guide" }], { g1: 3 }, {}, true);
    assert.equal(c.task_guidance, "met");
    assert.ok(!c.task_guidance_coerced);
    assert.equal(c.score_0_100, 100);
  });

  test("I: product-only met without guidanceRequired is untouched (100)", () => {
    const c = card(product, { p1: 3 });
    assert.equal(c.score_0_100, 100);
    assert.equal(c.task_guidance, "met");
    assert.ok(!c.task_guidance_coerced);
  });

  test("J: same fixture with guidanceRequired is coerced and capped (69)", () => {
    const c = card(product, { p1: 3 }, {}, true);
    assert.equal(c.score_0_100, 69);
    assert.equal(c.task_guidance_coerced, true);
  });
});
