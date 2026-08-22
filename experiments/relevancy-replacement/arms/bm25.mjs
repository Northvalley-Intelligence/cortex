/**
 * Arm A -- BM25 lexical baseline (handoff 01).
 *
 * Loads the FROZEN index + thresholds written by scripts/calibrate_bm25.mjs
 * (calibrated on ESCI-train ONLY) and applies them unchanged to every eval
 * set. Never recalibrates, never reads eval data. Expected to be weak
 * (lexical overlap != intent) -- see journal 04 for the honest read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scoreBm25 } from "../src/bm25.mjs";

export const ARM_NAME = "bm25";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

let _index = null;
let _thresholds = null;

function load() {
  if (_index && _thresholds) return { index: _index, thresholds: _thresholds };
  _index = JSON.parse(readFileSync(path.join(DATA_DIR, "bm25_index.json"), "utf8"));
  const t = JSON.parse(readFileSync(path.join(DATA_DIR, "bm25_thresholds.json"), "utf8"));
  _thresholds = t.thresholds;
  return { index: _index, thresholds: _thresholds };
}

function gradeFromScore(score, thresholds) {
  const [t0, t1, t2] = thresholds;
  if (score <= t0) return 0;
  if (score <= t1) return 1;
  if (score <= t2) return 2;
  return 3;
}

/** predict(pairs): pairs = [{ query, title }] -> [{ pred_grade, latency_ms, cold }] */
export function predict(pairs) {
  const { index, thresholds } = load();
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    const start = process.hrtime.bigint();
    const score = scoreBm25(pairs[i].query, pairs[i].title, index);
    const pred_grade = gradeFromScore(score, thresholds);
    const end = process.hrtime.bigint();
    const latency_ms = Number(end - start) / 1e6;
    out.push({ pred_grade, latency_ms, cold: i === 0 });
  }
  return out;
}
