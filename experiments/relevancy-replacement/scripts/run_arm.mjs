#!/usr/bin/env node
/**
 * Run an arm against a dataset jsonl file and write results/<arm>__<dataset>.json.
 *
 * Usage: node scripts/run_arm.mjs <arm-module-relative-to-arms/> <dataset-file-relative-to-data/>
 * Example: node scripts/run_arm.mjs stub.mjs cortex_validations.jsonl
 *
 * The dataset file must have per-line JSON objects containing `query`, `title`,
 * and a gold-grade field: `grade` (ESCI/WANDS jsonl) or `cortex_grade`
 * (cortex_validations.jsonl -- Cortex's own historical grade, audited not
 * assumed correct).
 *
 * Never overwrites silently: if the output path already exists, the previous
 * file is renamed aside with its own timestamp suffix first.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateArm } from "../src/evaluate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARMS_DIR = path.join(__dirname, "..", "arms");
const DATA_DIR = path.join(__dirname, "..", "data");
const RESULTS_DIR = path.join(__dirname, "..", "results");

async function main() {
  const [armFile, datasetFile] = process.argv.slice(2);
  if (!armFile || !datasetFile) {
    console.error("Usage: node scripts/run_arm.mjs <arm-file> <dataset-file>");
    process.exit(1);
  }

  const armModule = await import(path.join(ARMS_DIR, armFile));
  const armName = armModule.ARM_NAME || path.basename(armFile, path.extname(armFile));

  const datasetPath = path.join(DATA_DIR, datasetFile);
  const datasetName = path.basename(datasetFile, path.extname(datasetFile));
  const lines = readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));

  const pairs = rows.map((r) => ({
    query: r.query,
    title: r.title,
    gold_grade: r.grade !== undefined ? r.grade : r.cortex_grade,
  }));

  const rssBefore = process.memoryUsage().rss;
  const predictions = armModule.predict(pairs.map((p) => ({ query: p.query, title: p.title })));
  const rssAfter = process.memoryUsage().rss;
  const peakRssBytes = Math.max(rssBefore, rssAfter);

  const evalPairs = pairs.map((p, i) => ({ ...p, pred_grade: predictions[i].pred_grade }));
  const timings = predictions.map((p) => ({ latency_ms: p.latency_ms, cold: !!p.cold }));

  const result = evaluateArm({
    arm: armName,
    dataset: datasetName,
    pairs: evalPairs,
    timings,
    peakRssBytes,
    extra: { dataset_file: datasetFile, n_source_rows: rows.length },
  });

  const outPath = path.join(RESULTS_DIR, `${armName}__${datasetName}.json`);
  if (existsSync(outPath)) {
    const stampedOld = outPath.replace(/\.json$/, `.superseded-${Date.now()}.json`);
    renameSync(outPath, stampedOld);
    console.log(`Existing result moved aside: ${stampedOld}`);
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
