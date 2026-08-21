/**
 * BDD-019, BDD-020 -- relevance judging and NDCG correctness.
 *
 * Split cleanly along Generation 0's finding: the ranking METRIC is reused from retail-search
 * and only checked for correctness/drift; the JUDGMENTS are where the real risk lives and get
 * the parsing and coverage scrutiny.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ndcgAtK } from "../src/vendor/retail-search-metrics.mjs";
import { parseJudgment, ndcgForJudgments, buildRelevanceJob, RELEVANCE_SCALE, buildJudgeSystemPrompt, DEFAULT_JUDGE_RUBRIC, JUDGE_SYSTEM_PROMPT, rubricHash } from "../src/relevance.mjs";

const UPSTREAM = "/Users/feroshjacob/code/retail-search/src/evaluation/metrics.js";

describe("BDD-019 NDCG math is correct and has not drifted from upstream", () => {
  test("a perfect ranking scores 1 and a fully-reversed ranking scores the known value", () => {
    // grade-3 item first => nDCG 1; grade-3 item second => 1/log2(3) = 0.6309.
    assert.equal(ndcgAtK(["a", "b"], { a: 3, b: 0 }, 10), 1);
    assert.equal(Number(ndcgAtK(["b", "a"], { a: 3, b: 0 }, 10).toFixed(4)), 0.6309);
  });

  test("graded gain uses 2^g - 1 and idealDCG==0 is guarded", () => {
    // Two relevant items, graded 3 and 1, ranked best-first: DCG = 7 + 1/log2(3).
    const perfect = ndcgAtK(["a", "b", "c"], { a: 3, b: 1, c: 0 }, 10);
    assert.equal(perfect, 1, "best-first graded ranking is ideal");
    // No relevant docs => nDCG defined as 0, not NaN.
    assert.equal(ndcgAtK(["a", "b"], { a: 0, b: 0 }, 10), 0);
  });

  test("the vendored copy still matches upstream retail-search byte-for-byte (drift guard)", (t) => {
    if (!existsSync(UPSTREAM)) {
      t.skip(`upstream ${UPSTREAM} not present; drift cannot be checked in this environment`);
      return;
    }
    const upstreamBody = readFileSync(UPSTREAM, "utf8");
    const vendored = readFileSync(new URL("../src/vendor/retail-search-metrics.mjs", import.meta.url), "utf8");
    // The vendored file is the upstream body with a provenance header prepended.
    assert.ok(vendored.endsWith(upstreamBody), "vendored metrics must contain upstream verbatim");
    const upstreamSha = createHash("sha256").update(upstreamBody).digest("hex");
    assert.match(vendored, new RegExp(upstreamSha), "the recorded upstream SHA must match the current upstream file");
  });
});

describe("BDD-020 judgments are parsed strictly, never fabricated", () => {
  test("valid judge JSON parses to an in-scale grade", () => {
    assert.deepEqual(parseJudgment('{"grade": 3, "reason": "exact match"}'), { grade: 3, reason: "exact match" });
  });

  test("qwen-style <think> blocks and markdown fences are stripped", () => {
    assert.equal(parseJudgment('<think>hmm</think>\n```json\n{"grade": 2, "reason": "ok"}\n```').grade, 2);
  });

  test("an out-of-scale grade is rejected, not clamped", () => {
    // The exact real failure: the model invented a 0-10 scale.
    assert.throws(() => parseJudgment('{"grade": 9, "reason": "9/10"}'), /outside the 0-3 scale/);
    assert.throws(() => parseJudgment("I would rate this 9/10."), /no JSON object/);
  });

  test("every scale point is documented", () => {
    assert.deepEqual(Object.keys(RELEVANCE_SCALE), ["0", "1", "2", "3"]);
  });
});

describe("NDCG refuses to score incomplete judgments (the plausible-wrong-number guard)", () => {
  test("a ranking with an unjudged item within k returns null, not a confident 0", () => {
    const result = ndcgForJudgments({
      ranking: ["p1", "p2", "p3"],
      judgments: [{ product_id: "p1", grade: 3 }], // p2, p3 unjudged
    });
    assert.equal(result.ndcg, null, "an incompletely-judged ranking must not produce a number");
    assert.equal(result.error, "incomplete_judgments");
    assert.deepEqual(result.unjudged_ids, ["p2", "p3"]);
  });

  test("a fully-judged ranking scores normally", () => {
    const result = ndcgForJudgments({
      ranking: ["p1", "p2", "p3"],
      judgments: [
        { product_id: "p1", grade: 3 },
        { product_id: "p2", grade: 0 },
        { product_id: "p3", grade: 1 },
      ],
    });
    assert.ok(result.ndcg > 0.9, `expected a strong nDCG for a good ranking, got ${result.ndcg}`);
    assert.equal(result.k, 3);
    assert.equal(result.candidates, 3);
  });

  test("requesting nDCG@10 over 8 candidates reports @8 with a warning, never silently pads to 10", () => {
    const ranking = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const judgments = ranking.map((id, i) => ({ product_id: id, grade: i < 3 ? 3 : 0 }));
    const result = ndcgForJudgments({ ranking, judgments, k: 10 });
    assert.equal(result.k, 8, "the actual depth is reported, not the requested 10");
    assert.match(result.warning, /only 8 candidates/, "the shortfall is surfaced, matching the ecommmerce-eval gap");
  });
});

describe("buildRelevanceJob shapes one traceable call per (query, product) pair", () => {
  test("each pair becomes a call carrying the judge system prompt and 0-temperature params", () => {
    const calls = buildRelevanceJob({
      queries: [{ query_id: "q1", query: "running shoes", products: [{ id: "p1", title: "Nike Pegasus" }, { id: "p2", title: "Belt" }] }],
      minContextWindow: 8192,
    });
    assert.equal(calls.length, 2, "one call per product = one trace per grade");
    assert.ok(calls[0].system_prompt.includes("relevance judge"));
    assert.equal(calls[0].params.temperature, 0, "judgments are deterministic for stability (BDD-020)");
    assert.equal(calls[0]._meta.query_id, "q1");
    assert.equal(calls[0]._meta.product_id, "p1");
  });
});

describe("the judge prompt is composed: Cortex owns the frame, the caller may own the rubric", () => {
  test("no rubric uses the default, and the frame (scale + JSON contract) is always present", () => {
    const p = buildJudgeSystemPrompt();
    assert.equal(p, JUDGE_SYSTEM_PROMPT, "default composed prompt is the exported back-compat value");
    assert.ok(p.includes("GRADE SCALE") && p.includes("3 = Perfect"), "0-3 scale is in the frame");
    assert.ok(p.includes("ONE line of raw JSON"), "JSON contract is in the frame");
    assert.ok(p.includes("MEASUREMENT NOTATION"), "default rubric is present when none supplied");
  });

  test("a caller rubric replaces the domain block but CANNOT drop the frame", () => {
    const custom = "RELEVANCE FOR A BOOK CATALOGUE:\n  - a study guide is not the book itself -> grade 1.";
    const p = buildJudgeSystemPrompt(custom);
    // Frame invariants survive.
    assert.ok(p.includes("GRADE SCALE") && p.includes("3 = Perfect"), "scale cannot be overridden away");
    assert.ok(p.includes("ONE line of raw JSON"), "format contract cannot be overridden away");
    // Domain swapped.
    assert.ok(p.includes("BOOK CATALOGUE") && p.includes("study guide"), "caller rubric is inserted");
    assert.ok(!p.includes("MEASUREMENT NOTATION"), "default rubric is replaced, not appended");
  });

  test("blank/whitespace rubric falls back to the default rather than producing an empty body", () => {
    assert.equal(buildJudgeSystemPrompt("   \n  "), JUDGE_SYSTEM_PROMPT);
    assert.equal(buildJudgeSystemPrompt(null), JUDGE_SYSTEM_PROMPT);
  });

  test("buildRelevanceJob threads the caller rubric into every call's system prompt", () => {
    const custom = "MY DOMAIN RULE: exact SKU match only.";
    const calls = buildRelevanceJob({
      queries: [{ query_id: "q1", query: "x", products: [{ id: "p1", title: "A" }, { id: "p2", title: "B" }] }],
      minContextWindow: 8192,
      rubric: custom,
    });
    assert.ok(calls.every((c) => c.system_prompt.includes("MY DOMAIN RULE")), "all judgments use the caller rubric");
    assert.ok(calls.every((c) => c.system_prompt.includes("GRADE SCALE")), "and all still carry the frame");
  });

  test("rubricHash is stable per instruction-set and differs when the rubric differs", () => {
    const a = rubricHash(buildJudgeSystemPrompt());
    const b = rubricHash(buildJudgeSystemPrompt());
    const c = rubricHash(buildJudgeSystemPrompt("different criteria entirely"));
    assert.equal(a, b, "same instructions -> same hash (a version id)");
    assert.notEqual(a, c, "different rubric -> different hash");
  });
});
