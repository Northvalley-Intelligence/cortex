#!/usr/bin/env node
/**
 * Build the stratified training subset for Arm C (bge-reranker-v2-m3 fine-tune),
 * handoff 03. Source is ALWAYS data/esci_train.jsonl (the query-disjoint TRAIN
 * split verified in journal 02) -- NEVER esci_test.jsonl or any *_eval_sample.jsonl,
 * so there is zero leakage from the sets Arms A/B were scored on.
 *
 * Sampling: BALANCED across grades (equal quota per grade, not proportional --
 * handoff 03 explicitly asks for "balanced across grades" so a 4-way classifier
 * head isn't just learning the majority-class prior), seeded (mulberry32, seed=42,
 * src/prng.mjs -- same PRNG family as every other sampler in this experiment).
 *
 * Output is split train/dev (90/10) purely for early-stopping during fine-tuning.
 * The dev split is still drawn from esci_train.jsonl -- it is NOT an eval set and
 * is never used for the arm's reported QWK/accuracy numbers, only to pick the
 * best training checkpoint.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mulberry32, seededShuffle } from "../src/prng.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SEED = 42;
const PER_GRADE_QUOTA = 10000; // 4 grades x 10,000 = 40,000 total
const DEV_FRACTION = 0.1;

function loadJsonl(p) {
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function main() {
  const sourcePath = path.join(DATA_DIR, "esci_train.jsonl");
  const rows = loadJsonl(sourcePath);
  const byGrade = new Map();
  for (const r of rows) {
    if (!byGrade.has(r.grade)) byGrade.set(r.grade, []);
    byGrade.get(r.grade).push(r);
  }
  const gradeCounts = Object.fromEntries([...byGrade.entries()].map(([g, arr]) => [g, arr.length]));
  console.log(`Source: ${sourcePath} (${rows.length} rows). Grade distribution: ${JSON.stringify(gradeCounts)}`);

  const rand = mulberry32(SEED);
  const picked = [];
  const quotas = {};
  for (const [grade, arr] of byGrade) {
    const shuffled = seededShuffle([...arr], rand);
    const quota = Math.min(PER_GRADE_QUOTA, arr.length);
    quotas[grade] = quota;
    picked.push(...shuffled.slice(0, quota));
  }
  seededShuffle(picked, rand); // interleave grades so train/dev split below isn't grade-blocked

  const devN = Math.round(picked.length * DEV_FRACTION);
  const dev = picked.slice(0, devN);
  const train = picked.slice(devN);

  const gradeDist = (arr) => {
    const d = {};
    for (const r of arr) d[r.grade] = (d[r.grade] ?? 0) + 1;
    return d;
  };

  const trainPath = path.join(DATA_DIR, "bge_train_subset.jsonl");
  const devPath = path.join(DATA_DIR, "bge_dev_subset.jsonl");
  writeFileSync(trainPath, train.map((r) => JSON.stringify({ query: r.query, title: r.title, grade: r.grade })).join("\n") + "\n", "utf8");
  writeFileSync(devPath, dev.map((r) => JSON.stringify({ query: r.query, title: r.title, grade: r.grade })).join("\n") + "\n", "utf8");

  const meta = {
    source: "esci_train.jsonl",
    source_split_note: "esci_train.jsonl is the ESCI-native query-disjoint TRAIN split (journal 02); esci_test.jsonl / esci_eval_sample.jsonl / wands_eval_sample.jsonl / cortex_validations_sample.jsonl are never read by this script.",
    seed: SEED,
    per_grade_quota: PER_GRADE_QUOTA,
    n_source_rows: rows.length,
    source_grade_distribution: gradeCounts,
    quotas,
    n_picked: picked.length,
    dev_fraction: DEV_FRACTION,
    n_train: train.length,
    n_dev: dev.length,
    train_grade_distribution: gradeDist(train),
    dev_grade_distribution: gradeDist(dev),
    method: "balanced stratified by gold grade (equal quota per grade, capped at availability), seeded (mulberry32, seed=42) sampling without replacement + seeded shuffle, then a seeded 90/10 train/dev split (dev used ONLY for early-stopping, never for reported eval metrics)",
  };
  const metaPath = path.join(DATA_DIR, "bge_train_subset_meta.json");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  console.log(`Picked ${picked.length} (quotas ${JSON.stringify(quotas)})`);
  console.log(`Train: ${train.length} (${JSON.stringify(gradeDist(train))})`);
  console.log(`Dev:   ${dev.length} (${JSON.stringify(gradeDist(dev))})`);
  console.log(`Wrote ${trainPath}, ${devPath}, ${metaPath}`);
}

main();
