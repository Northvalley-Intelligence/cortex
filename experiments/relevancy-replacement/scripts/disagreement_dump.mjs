#!/usr/bin/env node
/**
 * Blind disagreement dump (handoff 07).
 *
 * Reads a per-pair prediction sidecar (produced by scripts/run_arm.mjs
 * --predictions-out) and emits, for every pair where the arm's predicted grade
 * differs from the dataset label:
 *
 *   disagreements-blind.md   -- | # | query | item | Grader A | Grader B |
 *   disagreements-key.json   -- the sealed answer key (seed + per-row mapping)
 *
 * WHY BLIND: the point is to judge the two grades on their merits. The dataset
 * label is Cortex's own historical judgment -- what is being AUDITED, not ground
 * truth -- so a disagreement is a finding, not an error, and the reviewer must
 * not be able to tell which column is which while judging. Which of Cortex/arm
 * lands in column A is therefore reshuffled PER ROW from a seeded PRNG, and no
 * arm name appears anywhere in the .md. The key file resolves every row and is
 * deliberately named so it cannot be confused with the dump.
 *
 * PRIVACY: the output contains raw queries/titles/judgments. This repo is PUBLIC
 * and commits no row-level data (2026-08-23 audit finding) -- the default output
 * directory is gitignored, and the real dump is written outside this repo. Never
 * commit either output file.
 *
 * Usage:
 *   node scripts/disagreement_dump.mjs <predictions.jsonl> [--out-dir <dir>] [--seed <n>]
 * Default --out-dir: results/disagreements/ (gitignored). Default --seed: 42.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mulberry32 } from "../src/prng.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.join(__dirname, "..", "results", "disagreements");
export const DEFAULT_SEED = 42;

/**
 * Make a string safe for one markdown table cell: escape the pipes that would
 * otherwise split the row (product titles in this dataset routinely contain
 * "|"), and flatten any embedded newlines.
 */
export function escapeCell(s) {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** Parse a JSONL prediction sidecar into rows. */
export function parsePredictions(text) {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Select the disagreeing pairs and assign each one a blind A/B orientation.
 *
 * The PRNG is advanced once per DISAGREEING row (not per input row) so the
 * assignment depends only on the seed and the disagreement sequence.
 * Returns { evaluated, disagreements, byDelta, rows } where each row carries
 * both the display values (a/b) and the resolution (aIs/bIs).
 */
export function buildDisagreements(preds, seed = DEFAULT_SEED) {
  const rand = mulberry32(seed);
  const byDelta = {};
  const rows = [];
  for (const p of preds) {
    const label = Number(p.label);
    const pred = Number(p.pred_grade);
    if (label === pred) continue;
    const delta = Math.abs(label - pred);
    byDelta[delta] = (byDelta[delta] || 0) + 1;
    const cortexFirst = rand() < 0.5;
    rows.push({
      row: rows.length + 1,
      index: p.index,
      query: p.query,
      item: p.item,
      a: cortexFirst ? label : pred,
      b: cortexFirst ? pred : label,
      aIs: cortexFirst ? "cortex" : "arm_d",
      bIs: cortexFirst ? "arm_d" : "cortex",
      delta,
    });
  }
  return { evaluated: preds.length, disagreements: rows.length, byDelta, rows };
}

/** Render the blind markdown. Contains NO arm names, by construction. */
export function renderBlindMarkdown(d) {
  const deltas = Object.keys(d.byDelta)
    .map(Number)
    .sort((x, y) => x - y);
  const pct = d.evaluated ? ((d.disagreements / d.evaluated) * 100).toFixed(1) : "0.0";
  const lines = [
    "# Blind disagreement review",
    "",
    "Two independent graders scored the same query/item pairs on a 0-3 relevance scale.",
    "These are the pairs they DISAGREED on. Which grader is in which column is shuffled",
    "per row, so the columns are not comparable down the page -- judge each row on its own.",
    "",
    "Neither grader is ground truth. For each row, decide which grade you would have given.",
    "",
    `- Pairs evaluated: **${d.evaluated}**`,
    `- Disagreements: **${d.disagreements}** (${pct}%)`,
    ...deltas.map((k) => `  - |Δ| = ${k}: ${d.byDelta[k]}`),
    "",
    "Grade scale: 0 = irrelevant, 1 = weak, 2 = related, 3 = exact match.",
    "",
    "| # | query | item | Grader A | Grader B |",
    "| --- | --- | --- | --- | --- |",
    ...d.rows.map(
      (r) => `| ${r.row} | ${escapeCell(r.query)} | ${escapeCell(r.item)} | ${r.a} | ${r.b} |`
    ),
    "",
  ];
  return lines.join("\n");
}

/** Render the sealed answer key: resolves every row back to its grader. */
export function renderKey(d, seed, sourceName) {
  return (
    JSON.stringify(
      {
        note: "SEALED ANSWER KEY for disagreements-blind.md -- do not read before judging.",
        seed,
        source: sourceName,
        pairs_evaluated: d.evaluated,
        disagreements: d.disagreements,
        by_abs_delta: d.byDelta,
        rows: d.rows.map((r) => ({
          row: r.row,
          index: r.index,
          A: r.aIs,
          B: r.bIs,
          A_grade: r.a,
          B_grade: r.b,
          cortex: r.aIs === "cortex" ? r.a : r.b,
          arm_d: r.aIs === "arm_d" ? r.a : r.b,
          abs_delta: r.delta,
        })),
      },
      null,
      2
    ) + "\n"
  );
}

function main() {
  const argv = process.argv.slice(2);
  const positionals = [];
  let outDir = DEFAULT_OUT_DIR;
  let seed = DEFAULT_SEED;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir") outDir = argv[++i];
    else if (argv[i] === "--seed") seed = Number(argv[++i]);
    else positionals.push(argv[i]);
  }
  const [predsFile] = positionals;
  if (!predsFile) {
    console.error(
      "Usage: node scripts/disagreement_dump.mjs <predictions.jsonl> [--out-dir <dir>] [--seed <n>]"
    );
    process.exit(1);
  }

  const preds = parsePredictions(readFileSync(predsFile, "utf8"));
  const d = buildDisagreements(preds, seed);
  mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, "disagreements-blind.md");
  const keyPath = path.join(outDir, "disagreements-key.json");
  writeFileSync(mdPath, renderBlindMarkdown(d));
  writeFileSync(keyPath, renderKey(d, seed, path.basename(predsFile)));

  console.log(`Pairs evaluated: ${d.evaluated}`);
  console.log(`Disagreements:   ${d.disagreements}`);
  for (const k of Object.keys(d.byDelta).sort()) console.log(`  |Δ|=${k}: ${d.byDelta[k]}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${keyPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
