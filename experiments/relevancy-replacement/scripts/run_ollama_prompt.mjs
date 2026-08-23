#!/usr/bin/env node
/**
 * Bespoke runner for Arm B (arms/ollama_prompt.mjs), handoff 02.
 *
 * NOT scripts/run_arm.mjs, on purpose: Arm B's predict step is a real async
 * network call (Ollama) that can fail to parse, and the handoff is explicit
 * that a parse failure must be recorded as a failure and reported as a rate
 * -- NEVER coerced to grade 0 and folded into the accuracy/QWK numbers. That
 * needs a filtering step run_arm.mjs's synchronous, always-succeeds `predict`
 * contract doesn't have room for, so this script owns the filtering and
 * writes the result JSON itself, using the same evaluateArm() + no-silent-
 * overwrite convention as run_arm.mjs.
 *
 * Cold vs warm: before the FIRST chunk of a dataset run, `ollama stop
 * <model>` unloads the model (verified this actually drops it from
 * `/api/ps`), so pair 0 overall is a genuine cold load. Every later call,
 * in this chunk or a later one, is warm -- no unload happens on resumed
 * chunks, so the model stays loaded across chunk boundaries (`keep_alive`
 * on every request).
 *
 * Concurrency (handoff 02, fix #1 vs the aborted serial run): a worker pool
 * of CONCURRENCY (default 4) in-flight Ollama requests at a time, within
 * each chunk. Pair 0 overall is dispatched first, alone, and awaited BEFORE
 * the pool starts (a clean, uncontended cold-load measurement); everything
 * else runs through the pool and is tagged warm. Measured on this machine:
 * concurrency 4 gives NO throughput win over serial for llama3.2:3b via
 * Ollama (~1.4-1.5 pairs/s either way) -- consistent with Ollama serializing
 * requests to a single loaded model instance on one GPU context, which is
 * also exactly why Cortex's own local provider hardcodes maxConcurrency:1
 * (src/config.mjs) for this provider. Kept at concurrency 4 per the handoff;
 * the null result is reported honestly in `extra`, not hidden.
 *
 * Chunking + checkpoint (needed because a full dataset run, ~18-36 min,
 * exceeds this tool's per-command timeout): each invocation processes at
 * most --limit pairs starting from wherever results/.checkpoints/<dataset>
 * .ollama_prompt.json left off, appends to that checkpoint, and only writes
 * the final results/<arm>__<dataset>.json once every row has been covered.
 * Re-running the same command with no more rows left is a no-op that just
 * finalizes from the checkpoint. This makes a long dataset drivable as a
 * sequence of separate, synchronous, in-turn command invocations with zero
 * background processes.
 *
 * Usage: node scripts/run_ollama_prompt.mjs <dataset-file-relative-to-data/> [--limit N] [--concurrency N] [--label NAME]
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateArm } from "../src/evaluate.mjs";
import { ARM_NAME, MODEL, judgeOne } from "../arms/ollama_prompt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const RESULTS_DIR = path.join(__dirname, "..", "results");
const CHECKPOINT_DIR = path.join(RESULTS_DIR, ".checkpoints");

function stopModel() {
  try {
    execFileSync("ollama", ["stop", MODEL], { stdio: "ignore" });
    return true;
  } catch (err) {
    console.warn(`Warning: could not run 'ollama stop ${MODEL}' (${err.message}). Cold measurement may not be a true cold load.`);
    return false;
  }
}

function checkpointPath(datasetName) {
  return path.join(CHECKPOINT_DIR, `${datasetName}.ollama_prompt.json`);
}

function loadCheckpoint(datasetName) {
  const p = checkpointPath(datasetName);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return { successPairs: [], timings: [], failures: [], nextIndex: 0, totalElapsedS: 0, forcedColdUnload: null };
}

function saveCheckpoint(datasetName, state) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(checkpointPath(datasetName), JSON.stringify(state));
}

async function main() {
  const args = process.argv.slice(2);
  const datasetFile = args[0];
  const limitIdx = args.indexOf("--limit");
  const chunkLimit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : null; // chunk size, not a dataset truncation
  const concurrencyIdx = args.indexOf("--concurrency");
  const concurrency = concurrencyIdx !== -1 ? Number(args[concurrencyIdx + 1]) : 4;
  const labelIdx = args.indexOf("--label");
  const labelOverride = labelIdx !== -1 ? args[labelIdx + 1] : null;
  if (!datasetFile) {
    console.error("Usage: node scripts/run_ollama_prompt.mjs <dataset-file> [--limit N] [--concurrency N] [--label NAME]");
    process.exit(1);
  }

  const datasetPath = path.join(DATA_DIR, datasetFile);
  // --label lets the output/result dataset name differ from the input file's basename, e.g.
  // input data/cortex_validations_sample.jsonl -> output results/ollama_prompt__cortex_validations.json
  // (handoff 02's exact naming), while data/ still holds the honestly-named "_sample" file.
  const datasetName = labelOverride || path.basename(datasetFile, path.extname(datasetFile));
  const lines = readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));

  const pairs = rows.map((r) => ({
    query: r.query,
    title: r.title,
    gold_grade: r.grade !== undefined ? r.grade : r.cortex_grade,
  }));

  const ckpt = loadCheckpoint(datasetName);
  const start = ckpt.nextIndex;
  const end = chunkLimit ? Math.min(pairs.length, start + chunkLimit) : pairs.length;

  if (start >= pairs.length) {
    console.log(`Dataset ${datasetName}: checkpoint already covers all ${pairs.length} rows. Finalizing only, no new Ollama calls.`);
  } else {
    console.log(`Dataset: ${datasetFile} (${pairs.length} pairs total). Chunk: [${start}, ${end}) of ${pairs.length}. Model: ${MODEL}. Concurrency: ${concurrency}.`);

    let stopped = ckpt.forcedColdUnload;
    if (start === 0) {
      stopped = stopModel();
      console.log(stopped ? `Unloaded ${MODEL} from Ollama -- first call below is a genuine cold load.` : `Proceeding without a forced unload.`);
      ckpt.forcedColdUnload = stopped;
    } else {
      console.log(`Resuming at index ${start} -- model assumed warm from a prior chunk (no unload).`);
    }

    const successPairs = [];
    const timings = [];
    const failures = [];
    let doneCount = 0;
    const chunkTotal = end - start;

    async function runOne(i, cold) {
      const p = pairs[i];
      try {
        const { pred_grade, latency_ms } = await judgeOne({ query: p.query, title: p.title });
        successPairs.push({ query: p.query, title: p.title, gold_grade: p.gold_grade, pred_grade });
        timings.push({ latency_ms, cold });
      } catch (err) {
        failures.push({ index: i, query: p.query, title: p.title, gold_grade: p.gold_grade, error: err.message });
      }
      doneCount++;
      if (doneCount % 100 === 0 || doneCount === chunkTotal) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ${doneCount}/${chunkTotal} (chunk) done (${failures.length} parse failures so far), ${elapsed}s elapsed`);
      }
    }

    const t0 = Date.now();
    let cursorStart = start;

    // Pair 0 of the WHOLE dataset, if it's in this chunk, first and alone --
    // a clean, uncontended cold-load measurement.
    if (start === 0) {
      await runOne(0, true);
      cursorStart = 1;
    }

    const remaining = [];
    for (let i = cursorStart; i < end; i++) remaining.push(i);
    let cursor = 0;
    async function worker() {
      for (;;) {
        const idx = cursor < remaining.length ? remaining[cursor++] : null;
        if (idx === null) return;
        await runOne(idx, false);
      }
    }
    const poolSize = Math.max(1, Math.min(concurrency, remaining.length || 1));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    const chunkElapsedS = (Date.now() - t0) / 1000;

    ckpt.successPairs.push(...successPairs);
    ckpt.timings.push(...timings);
    ckpt.failures.push(...failures);
    ckpt.nextIndex = end;
    ckpt.totalElapsedS += chunkElapsedS;
    saveCheckpoint(datasetName, ckpt);
    console.log(`Chunk done in ${chunkElapsedS.toFixed(1)}s. Checkpoint now at ${ckpt.nextIndex}/${pairs.length}.`);
  }

  if (ckpt.nextIndex < pairs.length) {
    console.log(`Not finalizing: ${ckpt.nextIndex}/${pairs.length} done. Re-run the same command to continue.`);
    return;
  }

  // Full dataset covered -- finalize.
  const nAttempted = pairs.length;
  const nParsed = ckpt.successPairs.length;
  const parseFailureRate = nAttempted > 0 ? ckpt.failures.length / nAttempted : null;
  const throughputPerSec = ckpt.totalElapsedS > 0 ? pairs.length / ckpt.totalElapsedS : null;

  const extra = {
    dataset_file: datasetFile,
    n_source_rows: rows.length,
    n_attempted: nAttempted,
    n_parsed: nParsed,
    parse_failure_count: ckpt.failures.length,
    parse_failure_rate: parseFailureRate,
    parse_failures_sample: ckpt.failures.slice(0, 20), // first 20 for inspection, not all (could be large)
    model: MODEL,
    forced_cold_unload: ckpt.forcedColdUnload,
    concurrency,
    total_elapsed_s: ckpt.totalElapsedS,
    effective_throughput_pairs_per_sec: throughputPerSec,
    run_in_chunks: true,
    rss_caveat: "peak_rss_bytes is null: this dataset was run across multiple separate chunked node processes (see docstring), so no single process RSS represents the whole run. Ollama itself (a separate process) holds the model weights (~5-6GB RSS per `ollama ps`), not measured here.",
  };
  if (datasetName === "cortex_validations") {
    extra.note = "reproduction — 92% of this set was generated by llama3.2:3b (see journal 03)";
  }

  const result = evaluateArm({
    arm: ARM_NAME,
    dataset: datasetName,
    pairs: ckpt.successPairs,
    timings: ckpt.timings,
    peakRssBytes: null, // not meaningful across separate chunk processes; see arm's own note
    extra,
  });

  const outPath = path.join(RESULTS_DIR, `${ARM_NAME}__${datasetName}.json`);
  if (existsSync(outPath)) {
    const stampedOld = outPath.replace(/\.json$/, `.superseded-${Date.now()}.json`);
    renameSync(outPath, stampedOld);
    console.log(`Existing result moved aside: ${stampedOld}`);
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(`n_attempted=${nAttempted} n_parsed=${nParsed} parse_failure_rate=${parseFailureRate}`);
  console.log(`QWK=${result.qwk} accuracy=${result.accuracy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
