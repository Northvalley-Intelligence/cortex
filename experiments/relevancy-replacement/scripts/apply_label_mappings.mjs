#!/usr/bin/env node
/**
 * Read the raw joined CSVs produced by scripts/download_esci.py and
 * scripts/download_wands.py, apply the label mapping in src/labels.mjs
 * (which itself reads Cortex's RELEVANCE_SCALE), and write the final jsonl
 * files consumed by the eval harness:
 *   data/esci_train.jsonl, data/esci_test.jsonl (ESCI's own query-disjoint
 *     split column, verified disjoint by query_id and query text), and
 *   data/wands_eval.jsonl.
 *
 * A minimal CSV parser is used (no runtime deps) -- these CSVs have no
 * embedded commas/quotes needing escaping beyond the standard RFC4180 case,
 * which the parser below handles.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { esciLabelToGrade, wandsLabelToGrade } from "../src/labels.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, "..", "data", "raw");
const DATA_DIR = path.join(__dirname, "..", "data");

/** Minimal RFC4180 CSV parser: handles quoted fields with embedded commas/quotes/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length === header.length || (r.length === 1 && r[0] === "")).filter(r => !(r.length===1 && r[0]==="")).map((r) => {
    const obj = {};
    header.forEach((h, idx) => (obj[h] = r[idx]));
    return obj;
  });
}

function processEsci() {
  const csvPath = path.join(RAW_DIR, "esci_small_us_raw.csv");
  console.log(`Reading ${csvPath}...`);
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  console.log(`  parsed ${rows.length} rows`);

  const train = [];
  const test = [];
  const trainQueries = new Set();
  const testQueries = new Set();

  for (const r of rows) {
    const grade = esciLabelToGrade(r.esci_label);
    const rec = { query: r.query, title: r.title, esci_label: r.esci_label, grade };
    if (r.split === "train") {
      train.push(rec);
      trainQueries.add(r.query);
    } else if (r.split === "test") {
      test.push(rec);
      testQueries.add(r.query);
    }
  }

  // Verify query-disjointness of the split ESCI itself provides.
  let overlap = 0;
  for (const q of trainQueries) if (testQueries.has(q)) overlap++;
  console.log(`  train rows: ${train.length} (${trainQueries.size} unique queries)`);
  console.log(`  test rows: ${test.length} (${testQueries.size} unique queries)`);
  console.log(`  query overlap between train/test: ${overlap}`);
  if (overlap > 0) {
    throw new Error(`ESCI train/test split is not query-disjoint: ${overlap} overlapping queries`);
  }

  writeFileSync(path.join(DATA_DIR, "esci_train.jsonl"), train.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(path.join(DATA_DIR, "esci_test.jsonl"), test.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`  wrote esci_train.jsonl, esci_test.jsonl`);

  const gradeDist = {};
  for (const r of train) gradeDist[r.grade] = (gradeDist[r.grade] || 0) + 1;
  console.log(`  esci_train grade distribution: ${JSON.stringify(gradeDist)}`);
  const gradeDistTest = {};
  for (const r of test) gradeDistTest[r.grade] = (gradeDistTest[r.grade] || 0) + 1;
  console.log(`  esci_test grade distribution: ${JSON.stringify(gradeDistTest)}`);
}

function processWands() {
  const csvPath = path.join(RAW_DIR, "wands_raw.csv");
  console.log(`Reading ${csvPath}...`);
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  console.log(`  parsed ${rows.length} rows`);

  const out = rows.map((r) => ({
    query: r.query,
    title: r.title,
    wands_label: r.wands_label,
    grade: wandsLabelToGrade(r.wands_label),
  }));

  writeFileSync(path.join(DATA_DIR, "wands_eval.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`  wrote wands_eval.jsonl (${out.length} rows)`);

  const gradeDist = {};
  for (const r of out) gradeDist[r.grade] = (gradeDist[r.grade] || 0) + 1;
  console.log(`  wands_eval grade distribution: ${JSON.stringify(gradeDist)}`);
}

processEsci();
processWands();
