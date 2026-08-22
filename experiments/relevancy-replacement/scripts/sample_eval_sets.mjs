#!/usr/bin/env node
/**
 * Build the seeded, stratified 3,000-pair eval samples the handoff specifies
 * (handoff 01, "because ESCI-test is 181k rows / WANDS is 233k rows, use a
 * fixed seeded random sample so this is tractable on one machine ... the SAME
 * sample is reused for every arm").
 *
 * Stratification: proportional-by-gold-grade -- each grade's quota is
 * proportional to its share of the SOURCE dataset (esci_test.jsonl /
 * wands_eval.jsonl), rounded to sum exactly to the target via the largest-
 * remainder method, then that many rows are drawn (without replacement,
 * seeded Fisher-Yates) from that grade's rows. The per-grade order is
 * shuffled again across grades so the output file isn't grade-blocked.
 *
 * Source: ESCI sample drawn from esci_test.jsonl (the query-disjoint held-out
 * split; esci_train.jsonl is reserved for BM25 calibration only, journal 02/03).
 * WANDS sample drawn from wands_eval.jsonl (WANDS is eval-only, journal 01 --
 * no train split exists or is needed for it).
 *
 * Deterministic: seed=42, mulberry32 (src/prng.mjs), same PRNG family as
 * evaluate.mjs's bootstrapQwkCI. Re-running this script reproduces byte-
 * identical output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mulberry32, seededShuffle } from "../src/prng.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SEED = 42;
const TARGET_N = 3000;

function loadJsonl(p) {
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Largest-remainder proportional allocation of `total` across grade counts, summing to exactly `total`. */
function allocateQuotas(gradeCounts, total) {
  const grades = Object.keys(gradeCounts).map(Number).sort((a, b) => a - b);
  const sourceTotal = grades.reduce((s, g) => s + gradeCounts[g], 0);
  const raw = grades.map((g) => (gradeCounts[g] / sourceTotal) * total);
  const floors = raw.map(Math.floor);
  let allocated = floors.reduce((a, b) => a + b, 0);
  const remainders = raw.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (allocated < total) {
    floors[remainders[idx % remainders.length].i] += 1;
    allocated++;
    idx++;
  }
  const quotas = {};
  grades.forEach((g, i) => (quotas[g] = floors[i]));
  return quotas;
}

function buildSample(sourcePath, outPath, label) {
  console.log(`\n=== ${label} ===`);
  const rows = loadJsonl(sourcePath);
  const byGrade = new Map();
  for (const r of rows) {
    if (!byGrade.has(r.grade)) byGrade.set(r.grade, []);
    byGrade.get(r.grade).push(r);
  }
  const gradeCounts = Object.fromEntries([...byGrade.entries()].map(([g, arr]) => [g, arr.length]));
  console.log(`Source: ${sourcePath} (${rows.length} rows). Grade distribution: ${JSON.stringify(gradeCounts)}`);

  const quotas = allocateQuotas(gradeCounts, TARGET_N);
  console.log(`Quotas (proportional, largest-remainder, sum=${Object.values(quotas).reduce((a, b) => a + b, 0)}): ${JSON.stringify(quotas)}`);

  const rand = mulberry32(SEED);
  const sample = [];
  for (const [grade, arr] of byGrade) {
    const shuffled = seededShuffle([...arr], rand);
    const quota = quotas[grade] ?? 0;
    sample.push(...shuffled.slice(0, quota));
  }
  seededShuffle(sample, rand); // interleave grades so the file isn't grade-blocked

  const outGradeCounts = {};
  for (const r of sample) outGradeCounts[r.grade] = (outGradeCounts[r.grade] ?? 0) + 1;
  console.log(`Sample size: ${sample.length}. Sample grade distribution: ${JSON.stringify(outGradeCounts)}`);

  const lines = sample.map((r) => JSON.stringify({ query: r.query, title: r.title, grade: r.grade }));
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${outPath}`);

  return { source: path.basename(sourcePath), n_source_rows: rows.length, seed: SEED, target_n: TARGET_N, n_sample: sample.length, source_grade_distribution: gradeCounts, quotas, sample_grade_distribution: outGradeCounts };
}

function main() {
  const esciMeta = buildSample(path.join(DATA_DIR, "esci_test.jsonl"), path.join(DATA_DIR, "esci_eval_sample.jsonl"), "ESCI eval sample (from esci_test.jsonl)");
  const wandsMeta = buildSample(path.join(DATA_DIR, "wands_eval.jsonl"), path.join(DATA_DIR, "wands_eval_sample.jsonl"), "WANDS eval sample (from wands_eval.jsonl)");

  const metaPath = path.join(DATA_DIR, "eval_sample_meta.json");
  writeFileSync(metaPath, JSON.stringify({ esci: esciMeta, wands: wandsMeta, method: "proportional stratified by gold grade, largest-remainder rounding, seeded (mulberry32, seed=42) sampling without replacement, then a seeded re-shuffle" }, null, 2) + "\n");
  console.log(`\nWrote ${metaPath}`);
}

main();
