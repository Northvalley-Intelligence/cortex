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
 *
 * PER-PAIR PREDICTION SIDECAR (opt-in, handoff 07)
 * ------------------------------------------------
 * By default this harness writes ONLY aggregate metrics: the per-pair grades
 * are computed in memory and discarded. That made the "which pairs does the
 * best arm disagree with Cortex on?" question unanswerable without a full
 * rerun, so runs can now opt in to keeping the rows:
 *
 *   node scripts/run_arm.mjs <arm> <dataset> --predictions-out
 *   node scripts/run_arm.mjs <arm> <dataset> --predictions-out <path>
 *   ARM_PREDICTIONS_OUT=1 node scripts/run_arm.mjs <arm> <dataset>
 *
 * A bare flag (or ARM_PREDICTIONS_OUT=1) writes the default path
 * results/predictions/<arm>__<dataset>.jsonl; a value (flag argument or
 * ARM_PREDICTIONS_OUT=<path>) writes there instead. One JSON object per line:
 * {index, query, item, label, pred_grade}.
 *
 * PRIVACY: those rows are raw queries/titles/judgments. This repo is PUBLIC and
 * commits no row-level data (2026-08-23 audit finding), so results/predictions/
 * is gitignored and the sidecar stays OFF unless explicitly requested. Do not
 * commit its output, and do not change that default.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateArm } from "../src/evaluate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARMS_DIR = path.join(__dirname, "..", "arms");
const DATA_DIR = path.join(__dirname, "..", "data");
const RESULTS_DIR = path.join(__dirname, "..", "results");

/**
 * Split `--predictions-out [path]` out of argv so the two positional arguments
 * keep working exactly as before. Returns { positionals, predictionsOut } where
 * predictionsOut is null (off), "" (on, use the default path), or a path.
 */
export function parseArgs(argv, env = {}) {
  const positionals = [];
  let predictionsOut = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--predictions-out") {
      // A following token that isn't another flag is this flag's value.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        predictionsOut = next;
        i++;
      } else {
        predictionsOut = "";
      }
    } else if (a.startsWith("--predictions-out=")) {
      predictionsOut = a.slice("--predictions-out=".length);
    } else {
      positionals.push(a);
    }
  }
  if (predictionsOut === null && env.ARM_PREDICTIONS_OUT) {
    const v = env.ARM_PREDICTIONS_OUT;
    predictionsOut = v === "1" || v === "true" ? "" : v;
  }
  return { positionals, predictionsOut };
}

async function main() {
  const { positionals, predictionsOut } = parseArgs(process.argv.slice(2), process.env);
  const [armFile, datasetFile] = positionals;
  if (!armFile || !datasetFile) {
    console.error(
      "Usage: node scripts/run_arm.mjs <arm-file> <dataset-file> [--predictions-out [path]]"
    );
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

  // RSS fix (handoff 03): process.memoryUsage() here only sees THIS Node process. That's
  // correct for an in-process arm (e.g. bm25) but wrong for an arm whose real inference
  // work happens in a subprocess (e.g. bge_reranker's Python/torch child) -- for those,
  // this harness process's own RSS is near-meaningless. An arm module that knows its own
  // real peak RSS better (e.g. it measured a spawned subprocess directly) can export
  // getPeakRssBytes(); when present, that value is used INSTEAD of the Node-process
  // measurement, so REAL, non-null RSS reaches the result JSON rather than a number that
  // silently under-reports (or null, as previously happened for multi-process chunked runs).
  const peakRssBytes =
    typeof armModule.getPeakRssBytes === "function"
      ? armModule.getPeakRssBytes()
      : Math.max(rssBefore, rssAfter);

  // Extra-fields fix (handoff 03): an arm can export getExtra() to attach its own
  // diagnostics (parse-failure rate, model identity, subprocess timings, RSS provenance,
  // reproduction notes, etc.) to the result JSON's `extra` field, merged with the baseline
  // dataset bookkeeping below. Arms that don't export it are unaffected (empty object).
  const armExtra = typeof armModule.getExtra === "function" ? armModule.getExtra() : {};

  const evalPairs = pairs.map((p, i) => ({ ...p, pred_grade: predictions[i].pred_grade }));
  const timings = predictions.map((p) => ({ latency_ms: p.latency_ms, cold: !!p.cold }));

  // Opt-in per-pair sidecar (see the module docstring). Written before scoring so
  // the rows survive even if evaluation throws. Row-level data -- gitignored, never committed.
  if (predictionsOut !== null) {
    const sidecarPath = predictionsOut
      ? path.resolve(predictionsOut)
      : path.join(RESULTS_DIR, "predictions", `${armName}__${datasetName}.jsonl`);
    mkdirSync(path.dirname(sidecarPath), { recursive: true });
    const jsonl = evalPairs
      .map((p, i) =>
        JSON.stringify({
          index: i,
          query: p.query,
          item: p.title,
          label: p.gold_grade,
          pred_grade: p.pred_grade,
        })
      )
      .join("\n");
    writeFileSync(sidecarPath, jsonl + "\n");
    console.log(`Wrote per-pair predictions: ${sidecarPath} (${evalPairs.length} rows)`);
  }

  // Reproduction-vs-accuracy note (journal 03/04): the Cortex past-validation set's "gold"
  // grades are Cortex's OWN historical judgments (92% from llama3.2:3b), not an independent
  // label -- any arm's score there measures agreement/reproduction, not accuracy. Attach the
  // same note every arm gets when scored against that set (previously only added by hand for
  // ollama_prompt's custom runner).
  const isCortexValidationsSet = datasetName.startsWith("cortex_validations");
  const note = isCortexValidationsSet
    ? "reproduction — 92% of this set was generated by llama3.2:3b (see journal 03); not an independent-accuracy measurement."
    : undefined;

  const result = evaluateArm({
    arm: armName,
    dataset: datasetName,
    pairs: evalPairs,
    timings,
    peakRssBytes,
    extra: { dataset_file: datasetFile, n_source_rows: rows.length, ...(note ? { note } : {}), ...armExtra },
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

// Only run when invoked as a script, so tests can import parseArgs without
// executing a run. Unchanged behaviour for `node scripts/run_arm.mjs ...`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
