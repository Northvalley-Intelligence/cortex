import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quadraticWeightedKappa,
  qwkFromConfusion,
  exactAccuracy,
  offByOneAccuracy,
  meanAbsoluteError,
  meanNdcg,
  speedStats,
  evaluateArm,
} from "../src/evaluate.mjs";

test("QWK is 1 for perfect agreement", () => {
  const gold = [0, 1, 2, 3, 0, 1, 2, 3];
  const pred = [0, 1, 2, 3, 0, 1, 2, 3];
  assert.equal(quadraticWeightedKappa(gold, pred), 1);
});

test("QWK penalizes far misses more than near misses", () => {
  const gold = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
  const nearMiss = [1, 0, 3, 2, 1, 0, 3, 2, 1, 0, 3, 2]; // all off-by-1
  const farMiss = [3, 2, 1, 0, 3, 2, 1, 0, 3, 2, 1, 0]; // all off-by-3/1 extremes
  const qwkNear = quadraticWeightedKappa(gold, nearMiss);
  const qwkFar = quadraticWeightedKappa(gold, farMiss);
  assert.ok(qwkNear > qwkFar, `expected near-miss QWK (${qwkNear}) > far-miss QWK (${qwkFar})`);
});

test("exact accuracy, off-by-one accuracy, MAE basic correctness", () => {
  const gold = [0, 1, 2, 3];
  const pred = [0, 2, 2, 1];
  assert.equal(exactAccuracy(gold, pred), 0.5); // matches at idx 0,2
  assert.equal(offByOneAccuracy(gold, pred), 0.75); // idx0 exact, idx1 off1, idx2 exact, idx3 off2(fail)
  assert.equal(meanAbsoluteError(gold, pred), (0 + 1 + 0 + 2) / 4);
});

test("meanNdcg is 1 when predicted ranking matches gold ranking within a query", () => {
  const pairs = [
    { query: "q1", title: "a", gold_grade: 3, pred_grade: 3 },
    { query: "q1", title: "b", gold_grade: 1, pred_grade: 1 },
    { query: "q1", title: "c", gold_grade: 0, pred_grade: 0 },
  ];
  const result = meanNdcg(pairs);
  assert.equal(result.queries, 1);
  assert.ok(Math.abs(result.mean_ndcg - 1) < 1e-9);
});

test("meanNdcg is less than 1 when the predicted ranking inverts gold order", () => {
  const pairs = [
    { query: "q1", title: "a", gold_grade: 3, pred_grade: 0 },
    { query: "q1", title: "b", gold_grade: 0, pred_grade: 3 },
  ];
  const result = meanNdcg(pairs);
  assert.ok(result.mean_ndcg < 1);
});

test("speedStats separates warm and cold and computes median/p95", () => {
  const timings = [
    { latency_ms: 100, cold: false },
    { latency_ms: 200, cold: false },
    { latency_ms: 300, cold: false },
    { latency_ms: 5000, cold: true },
  ];
  const stats = speedStats(timings);
  assert.equal(stats.warm.n, 3);
  assert.equal(stats.cold.n, 1);
  assert.equal(stats.cold.median_ms, 5000);
});

test("qwkFromConfusion agrees with quadraticWeightedKappa on the same data (Arm A calibration path)", () => {
  const gold = [0, 1, 2, 3, 0, 2, 1, 3, 0, 0, 3, 2, 1, 1, 2, 3];
  const pred = [0, 1, 1, 3, 1, 2, 0, 2, 0, 1, 3, 2, 2, 1, 2, 0];
  const fromArrays = quadraticWeightedKappa(gold, pred);

  const confusion = Array.from({ length: 4 }, () => new Array(4).fill(0));
  for (let i = 0; i < gold.length; i++) confusion[gold[i]][pred[i]]++;
  const fromConfusion = qwkFromConfusion(confusion);

  assert.ok(Math.abs(fromArrays - fromConfusion) < 1e-12, `${fromArrays} vs ${fromConfusion}`);
});

test("qwkFromConfusion is 1 for a perfect-agreement confusion matrix", () => {
  const confusion = [
    [5, 0, 0, 0],
    [0, 3, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 2],
  ];
  assert.equal(qwkFromConfusion(confusion), 1);
});

test("evaluateArm produces all required fields", () => {
  const pairs = [
    { query: "q1", title: "a", gold_grade: 2, pred_grade: 2 },
    { query: "q1", title: "b", gold_grade: 0, pred_grade: 2 },
  ];
  const timings = [
    { latency_ms: 10, cold: false },
    { latency_ms: 12, cold: false },
  ];
  const result = evaluateArm({ arm: "stub", dataset: "test", pairs, timings, peakRssBytes: 12345 });
  assert.equal(result.arm, "stub");
  assert.equal(result.dataset, "test");
  assert.equal(result.n_pairs, 2);
  assert.ok("qwk" in result);
  assert.ok("qwk_ci95" in result);
  assert.ok("accuracy" in result);
  assert.ok("off_by_one_accuracy" in result);
  assert.ok("mae" in result);
  assert.ok("ndcg" in result);
  assert.ok("speed" in result);
  assert.equal(result.peak_rss_bytes, 12345);
  assert.ok(result.timestamp);
});
