#!/usr/bin/env node
/**
 * Calibrate Arm A (BM25) thresholds on ESCI-TRAIN ONLY -- never on any eval
 * set (handoff 01, acceptance criterion 3: no eval-set leakage).
 *
 * Method (quantile-binned grid search, maximizing QWK):
 *   1. Build a BM25 index (IDF/avgdl) from the DISTINCT titles in ESCI-train.
 *   2. Score every (query, title) row in ESCI-train.
 *   3. Sort rows by score; cut into BIN_COUNT (=100) equal-COUNT bins (quantile
 *      bins, not equal-width -- score is heavily right-skewed).
 *   4. Build a per-bin histogram of gold ESCI-train grades, then prefix-sum it
 *      so any candidate 3-cut-point threshold triple's resulting 4x4 confusion
 *      matrix (grade groups [bin0..b1), [b1..b2), [b2..b3), [b3..100)) can be
 *      read off in O(1) instead of re-scanning all 419k rows per candidate.
 *   5. Grid search ALL C(99,3) = 156,849 triples of bin-boundary cut points,
 *      score each with qwkFromConfusion (src/evaluate.mjs), keep the argmax.
 *   6. Freeze the winning triple's boundary SCORE values as the 3 thresholds;
 *      predict-time rule: grade 0 if score<=t0, 1 if score<=t1, 2 if score<=t2,
 *      else grade 3. This assumes BM25 score is monotonically informative
 *      (higher lexical overlap -> higher relevance), which quantile-bin grid
 *      search does not itself assume but the "4 contiguous score bands map to
 *      4 ordinal grades" rule does -- documented, and checked by the reported
 *      calibration QWK (a bad assumption would show up as a low QWK).
 *
 * Writes:
 *   data/bm25_index.json      -- frozen IDF/avgdl/N/k1/b (Arm A loads this, never rebuilds)
 *   data/bm25_thresholds.json -- frozen [t0,t1,t2] + calibration QWK + method + corpus stats
 *
 * Both are ESCI-train-derived only; nothing in this script reads esci_test.jsonl,
 * wands_eval.jsonl, wands_eval_sample.jsonl, esci_eval_sample.jsonl, or cortex_validations.jsonl.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCorpusIndex, scoreBm25 } from "../src/bm25.mjs";
import { qwkFromConfusion } from "../src/evaluate.mjs";
import { VALID_GRADES } from "../src/labels.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const TRAIN_PATH = path.join(DATA_DIR, "esci_train.jsonl");
const BIN_COUNT = 100;

function loadTrain() {
  const lines = readFileSync(TRAIN_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

function main() {
  console.log(`Loading ${TRAIN_PATH} ...`);
  const rows = loadTrain();
  console.log(`Loaded ${rows.length} ESCI-train rows.`);

  console.log("Building BM25 index over DISTINCT ESCI-train titles ...");
  const titles = rows.map((r) => r.title);
  const index = buildCorpusIndex(titles);
  console.log(`Corpus: ${index.N} distinct titles, ${Object.keys(index.idf).length} vocab terms, avgdl=${index.avgdl.toFixed(2)}.`);

  console.log("Scoring all ESCI-train rows with BM25 ...");
  const scored = rows.map((r) => ({ score: scoreBm25(r.query, r.title, index), grade: r.grade }));
  scored.sort((a, b) => a.score - b.score);
  console.log(`Scored ${scored.length} rows. Score range: [${scored[0].score.toFixed(4)}, ${scored[scored.length - 1].score.toFixed(4)}].`);

  // --- Quantile bins ---
  const N = scored.length;
  const grades = [...VALID_GRADES].sort((a, b) => a - b); // [0,1,2,3]
  const gradeIdx = new Map(grades.map((g, i) => [g, i]));
  const nGrades = grades.length;

  const binEdgeIdx = []; // row index (in `scored`) where each bin STARTS, length BIN_COUNT+1
  for (let i = 0; i <= BIN_COUNT; i++) binEdgeIdx.push(Math.round((i * N) / BIN_COUNT));

  // Per-bin histogram of gold grade counts.
  const hist = Array.from({ length: BIN_COUNT }, () => new Array(nGrades).fill(0));
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    for (let i = binEdgeIdx[bin]; i < binEdgeIdx[bin + 1]; i++) {
      hist[bin][gradeIdx.get(scored[i].grade)]++;
    }
  }
  // Prefix sums: prefix[bin][g] = sum of hist[0..bin)[g]
  const prefix = Array.from({ length: BIN_COUNT + 1 }, () => new Array(nGrades).fill(0));
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    for (let g = 0; g < nGrades; g++) prefix[bin + 1][g] = prefix[bin][g] + hist[bin][g];
  }
  const rangeCount = (fromBin, toBin, g) => prefix[toBin][g] - prefix[fromBin][g]; // [fromBin,toBin)

  console.log(`Grid search over C(${BIN_COUNT - 1},3) bin-boundary triples ...`);
  let best = { qwk: -Infinity, b1: null, b2: null, b3: null };
  for (let b1 = 1; b1 < BIN_COUNT - 2; b1++) {
    for (let b2 = b1 + 1; b2 < BIN_COUNT - 1; b2++) {
      for (let b3 = b2 + 1; b3 < BIN_COUNT; b3++) {
        // confusion[goldGradeIdx][predGradeIdx]
        const confusion = Array.from({ length: nGrades }, () => new Array(nGrades).fill(0));
        const groups = [
          [0, b1],
          [b1, b2],
          [b2, b3],
          [b3, BIN_COUNT],
        ];
        for (let predIdx = 0; predIdx < nGrades; predIdx++) {
          const [from, to] = groups[predIdx];
          for (let g = 0; g < nGrades; g++) confusion[g][predIdx] = rangeCount(from, to, grades[g]);
        }
        const qwk = qwkFromConfusion(confusion, grades[0], grades[grades.length - 1]);
        if (qwk !== null && qwk > best.qwk) best = { qwk, b1, b2, b3 };
      }
    }
  }
  console.log(`Best: bin cuts (${best.b1}, ${best.b2}, ${best.b3}), calibration QWK=${best.qwk.toFixed(4)}`);

  // Freeze threshold SCORE values at the winning bin boundaries: threshold_i is the midpoint
  // between the last score of the bin below the cut and the first score of the bin at/after it.
  function boundaryScore(binIdx) {
    const belowIdx = Math.max(0, binEdgeIdx[binIdx] - 1);
    const atIdx = Math.min(N - 1, binEdgeIdx[binIdx]);
    return (scored[belowIdx].score + scored[atIdx].score) / 2;
  }
  const thresholds = [boundaryScore(best.b1), boundaryScore(best.b2), boundaryScore(best.b3)];
  console.log(`Frozen thresholds: [${thresholds.map((t) => t.toFixed(4)).join(", ")}]`);

  // --- Sanity re-check: apply the frozen thresholds directly (not the bin machinery) and
  // recompute QWK the "normal" way, to prove the bin-based search and the real predict-time
  // rule agree (protects against an off-by-one between bin index math and threshold rule).
  const pred = scored.map((r) => predictGrade(r.score, thresholds));
  const gold = scored.map((r) => r.grade);
  const confusionCheck = Array.from({ length: nGrades }, () => new Array(nGrades).fill(0));
  for (let i = 0; i < gold.length; i++) confusionCheck[gradeIdx.get(gold[i])][gradeIdx.get(pred[i])]++;
  const qwkCheck = qwkFromConfusion(confusionCheck, grades[0], grades[grades.length - 1]);
  console.log(`Re-check QWK applying frozen thresholds directly: ${qwkCheck.toFixed(4)} (should equal ${best.qwk.toFixed(4)})`);

  const indexOut = path.join(DATA_DIR, "bm25_index.json");
  writeFileSync(indexOut, JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${indexOut}`);

  const thresholdsOut = path.join(DATA_DIR, "bm25_thresholds.json");
  writeFileSync(
    thresholdsOut,
    JSON.stringify(
      {
        thresholds,
        rule: "grade 0 if score<=t0; 1 if score<=t1; 2 if score<=t2; else 3",
        calibration_qwk: best.qwk,
        recheck_qwk: qwkCheck,
        method: "quantile-binned grid search (100 equal-count bins over ESCI-train BM25 scores, grid search over all C(99,3) bin-boundary triples, argmax QWK computed via a confusion-matrix prefix-sum, per calibrate_bm25.mjs)",
        calibrated_on: "esci_train.jsonl (ESCI-train only, no eval-set leakage)",
        n_train_rows: N,
        bin_count: BIN_COUNT,
        corpus_n_titles: index.N,
        corpus_vocab_size: Object.keys(index.idf).length,
        bin_cuts: [best.b1, best.b2, best.b3],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote ${thresholdsOut}`);
}

function predictGrade(score, thresholds) {
  const [t0, t1, t2] = thresholds;
  if (score <= t0) return 0;
  if (score <= t1) return 1;
  if (score <= t2) return 2;
  return 3;
}

main();
