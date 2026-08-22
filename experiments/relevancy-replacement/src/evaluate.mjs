/**
 * Eval harness: given an arm's predicted grades and a dataset's gold grades
 * (both on Cortex's 0-3 RELEVANCE_SCALE, per src/labels.mjs), compute the
 * metrics journal 01 specifies:
 *   - QWK (headline), with bootstrap 95% CI
 *   - exact accuracy, +-1 accuracy, MAE (secondary)
 *   - NDCG, via Cortex's own vendored ranking metric (never reimplemented)
 *   - speed: median/p95 latency per pair, peak RSS, warm vs cold separated
 *
 * Input shape per pair: { query, title, gold_grade, pred_grade, latency_ms? }
 * NDCG is computed per-query: pairs are grouped by `query`, ranked by
 * pred_grade descending (ties broken by input order), and scored against gold
 * grades as qrels via ndcgAtK from Cortex's vendored metrics. Reported NDCG is
 * the mean over queries that have at least one gold-relevant (grade > 0) item
 * (ndcgAtK returns 0 for an all-irrelevant qrels set, which is a real score,
 * not a missing one -- but a query with zero candidates has nothing to rank
 * and is excluded rather than silently contributing an undefined 0).
 */
import { ndcgAtK } from "../../../src/vendor/retail-search-metrics.mjs";
import { VALID_GRADES } from "./labels.mjs";

/** Quadratic Weighted Kappa between two integer-labeled sequences on the same ordinal scale. */
export function quadraticWeightedKappa(gold, pred, minGrade = Math.min(...VALID_GRADES), maxGrade = Math.max(...VALID_GRADES)) {
  const n = maxGrade - minGrade + 1;
  const confusion = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < gold.length; i++) {
    confusion[gold[i] - minGrade][pred[i] - minGrade]++;
  }
  const goldHist = new Array(n).fill(0);
  const predHist = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      goldHist[i] += confusion[i][j];
      predHist[j] += confusion[i][j];
    }
  }
  const total = gold.length;
  if (total === 0) return null;

  const weights = Array.from({ length: n }, (_, i) => new Array(n).fill(0).map((_, j) => ((i - j) ** 2) / ((n - 1) ** 2 || 1)));

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const observed = confusion[i][j] / total;
      const expected = (goldHist[i] * predHist[j]) / (total * total);
      numerator += weights[i][j] * observed;
      denominator += weights[i][j] * expected;
    }
  }
  if (denominator === 0) return numerator === 0 ? 1 : 0;
  return 1 - numerator / denominator;
}

/** Bootstrap 95% CI for QWK over paired (gold, pred) arrays. Deterministic given a seed. */
export function bootstrapQwkCI(gold, pred, { resamples = 1000, seed = 42 } = {}) {
  const n = gold.length;
  if (n === 0) return { low: null, high: null, resamples };
  // Small deterministic PRNG (mulberry32) so results are reproducible without a runtime dep.
  let state = seed >>> 0;
  function rand() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const scores = [];
  for (let b = 0; b < resamples; b++) {
    const gs = new Array(n);
    const ps = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      gs[i] = gold[idx];
      ps[i] = pred[idx];
    }
    const qwk = quadraticWeightedKappa(gs, ps);
    if (qwk !== null) scores.push(qwk);
  }
  scores.sort((a, b) => a - b);
  const lowIdx = Math.floor(0.025 * scores.length);
  const highIdx = Math.min(scores.length - 1, Math.ceil(0.975 * scores.length) - 1);
  return { low: scores[lowIdx] ?? null, high: scores[highIdx] ?? null, resamples };
}

/**
 * QWK computed directly from a confusion matrix (confusion[goldIdx][predIdx], 0-indexed by
 * grade - minGrade), rather than from raw (gold,pred) arrays. Same formula as
 * quadraticWeightedKappa above -- added for Arm A's BM25 threshold calibration (handoff 01),
 * which needs to score ~150k candidate threshold triples against ESCI-train and cannot afford
 * an O(n) pass per candidate; a histogram/prefix-sum confusion matrix makes each candidate O(1).
 * Cross-checked in test/evaluate.test.mjs against quadraticWeightedKappa on the same data.
 */
export function qwkFromConfusion(confusion, minGrade = Math.min(...VALID_GRADES), maxGrade = Math.max(...VALID_GRADES)) {
  const n = maxGrade - minGrade + 1;
  const goldHist = new Array(n).fill(0);
  const predHist = new Array(n).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = confusion[i][j];
      goldHist[i] += c;
      predHist[j] += c;
      total += c;
    }
  }
  if (total === 0) return null;

  const weights = Array.from({ length: n }, (_, i) => new Array(n).fill(0).map((_, j) => ((i - j) ** 2) / ((n - 1) ** 2 || 1)));

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const observed = confusion[i][j] / total;
      const expected = (goldHist[i] * predHist[j]) / (total * total);
      numerator += weights[i][j] * observed;
      denominator += weights[i][j] * expected;
    }
  }
  if (denominator === 0) return numerator === 0 ? 1 : 0;
  return 1 - numerator / denominator;
}

export function exactAccuracy(gold, pred) {
  if (gold.length === 0) return null;
  let hits = 0;
  for (let i = 0; i < gold.length; i++) if (gold[i] === pred[i]) hits++;
  return hits / gold.length;
}

export function offByOneAccuracy(gold, pred) {
  if (gold.length === 0) return null;
  let hits = 0;
  for (let i = 0; i < gold.length; i++) if (Math.abs(gold[i] - pred[i]) <= 1) hits++;
  return hits / gold.length;
}

export function meanAbsoluteError(gold, pred) {
  if (gold.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < gold.length; i++) sum += Math.abs(gold[i] - pred[i]);
  return sum / gold.length;
}

/** Mean NDCG across queries, computed via Cortex's vendored ndcgAtK. */
export function meanNdcg(pairs) {
  const byQuery = new Map();
  for (const p of pairs) {
    if (!byQuery.has(p.query)) byQuery.set(p.query, []);
    byQuery.get(p.query).push(p);
  }
  const perQuery = [];
  for (const [query, items] of byQuery) {
    if (items.length === 0) continue;
    const ranked = [...items]
      .map((item, idx) => ({ ...item, _idx: idx }))
      .sort((a, b) => b.pred_grade - a.pred_grade || a._idx - b._idx);
    const results = ranked.map((_, i) => String(i)); // synthetic ids, positional
    const qrels = {};
    ranked.forEach((item, i) => (qrels[String(i)] = item.gold_grade));
    const k = Math.max(1, Math.min(10, results.length));
    const ndcg = ndcgAtK(results, qrels, k, { relevanceMode: "graded" });
    perQuery.push({ query, ndcg, n: items.length });
  }
  if (perQuery.length === 0) return { mean_ndcg: null, queries: 0 };
  const mean = perQuery.reduce((s, q) => s + q.ndcg, 0) / perQuery.length;
  return { mean_ndcg: mean, queries: perQuery.length };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

/**
 * Speed stats from an array of per-pair timing records: { latency_ms, cold }.
 * Warm and cold are reported separately since cold includes model load
 * (measured 10x gap for llama3.2:3b per the contract journal).
 */
export function speedStats(timings) {
  const warm = timings.filter((t) => !t.cold).map((t) => t.latency_ms).sort((a, b) => a - b);
  const cold = timings.filter((t) => t.cold).map((t) => t.latency_ms).sort((a, b) => a - b);
  return {
    warm: {
      n: warm.length,
      median_ms: percentile(warm, 0.5),
      p95_ms: percentile(warm, 0.95),
    },
    cold: {
      n: cold.length,
      median_ms: percentile(cold, 0.5),
      p95_ms: percentile(cold, 0.95),
    },
  };
}

/**
 * Full evaluation for one arm on one dataset.
 * `pairs`: [{ query, title, gold_grade, pred_grade }]
 * `timings`: [{ latency_ms, cold }] (may be a subset/summary; arms report their own timings)
 * `peakRssBytes`: number, measured by the harness/arm around inference
 */
export function evaluateArm({ arm, dataset, pairs, timings = [], peakRssBytes = null, extra = {} }) {
  const gold = pairs.map((p) => p.gold_grade);
  const pred = pairs.map((p) => p.pred_grade);

  const qwk = quadraticWeightedKappa(gold, pred);
  const qwkCi = bootstrapQwkCI(gold, pred, { resamples: 1000, seed: 42 });
  const accuracy = exactAccuracy(gold, pred);
  const offByOne = offByOneAccuracy(gold, pred);
  const mae = meanAbsoluteError(gold, pred);
  const ndcgResult = meanNdcg(pairs);
  const speed = speedStats(timings);

  return {
    arm,
    dataset,
    n_pairs: pairs.length,
    timestamp: new Date().toISOString(),
    qwk,
    qwk_ci95: qwkCi,
    accuracy,
    off_by_one_accuracy: offByOne,
    mae,
    ndcg: ndcgResult,
    speed,
    peak_rss_bytes: peakRssBytes,
    extra,
  };
}
