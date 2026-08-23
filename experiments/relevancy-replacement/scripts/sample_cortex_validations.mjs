#!/usr/bin/env node
/**
 * Build a seeded, stratified 1,500-row sample of data/cortex_validations.jsonl
 * for Arm B (handoff 02): "Sample the Cortex set ... 1,500-row stratified
 * sample of cortex_validations.jsonl (seed=42, stratified by cortex_grade),
 * written once to data/cortex_validations_sample.jsonl and reused."
 *
 * Same method as scripts/sample_eval_sets.mjs (proportional-by-grade quotas,
 * largest-remainder rounding, seeded mulberry32 sampling without replacement,
 * then a seeded re-shuffle so the file isn't grade-blocked) -- reused here
 * rather than reimplemented, so this sample is drawn the same way as the
 * ESCI/WANDS eval samples it will sit alongside in results comparisons.
 *
 * Output rows keep `grade` (renamed from `cortex_grade`) so
 * scripts/run_ollama_prompt.mjs's `r.grade !== undefined ? r.grade :
 * r.cortex_grade` picks it up the same way as the ESCI/WANDS samples do.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mulberry32, seededShuffle } from "../src/prng.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SEED = 42;
const TARGET_N = 1500;

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

function main() {
  const sourcePath = path.join(DATA_DIR, "cortex_validations.jsonl");
  const outPath = path.join(DATA_DIR, "cortex_validations_sample.jsonl");
  const rows = loadJsonl(sourcePath);

  const byGrade = new Map();
  for (const r of rows) {
    if (!byGrade.has(r.cortex_grade)) byGrade.set(r.cortex_grade, []);
    byGrade.get(r.cortex_grade).push(r);
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
  for (const r of sample) outGradeCounts[r.cortex_grade] = (outGradeCounts[r.cortex_grade] ?? 0) + 1;
  console.log(`Sample size: ${sample.length}. Sample grade distribution: ${JSON.stringify(outGradeCounts)}`);

  const lines = sample.map((r) => JSON.stringify({ query: r.query, title: r.title, grade: r.cortex_grade }));
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${outPath}`);

  const metaPath = path.join(DATA_DIR, "cortex_validations_sample_meta.json");
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        source: path.basename(sourcePath),
        n_source_rows: rows.length,
        seed: SEED,
        target_n: TARGET_N,
        n_sample: sample.length,
        source_grade_distribution: gradeCounts,
        quotas,
        sample_grade_distribution: outGradeCounts,
        method: "proportional stratified by cortex_grade, largest-remainder rounding, seeded (mulberry32, seed=42) sampling without replacement, then a seeded re-shuffle",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote ${metaPath}`);
}

main();
