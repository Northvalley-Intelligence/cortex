#!/usr/bin/env node
/**
 * Score Cortex-LOCAL, LIVE, on an eval sample -- the baseline every arm must
 * beat (handoff 02: "score Cortex-local on the SAME esci_eval_sample and
 * wands_eval_sample ... force CORTEX_PROVIDER_CHAIN=local ... never edit
 * .env.local").
 *
 * How the chain is forced without editing .env.local or touching the
 * already-running production server (pid on :7077, started from
 * data/cortex.db + whatever .env.local holds): this script spawns a SECOND,
 * throwaway instance of Cortex's own `src/server.mjs` (unmodified -- Cortex
 * code is never edited), with:
 *   - CORTEX_PROVIDER_CHAIN=local   (env var scoped to this child process only)
 *   - CORTEX_PORT=<scratch port>    (does not collide with the real :7077)
 *   - CORTEX_DB=<scratch db path>   (a NEW sqlite file under this experiment's
 *     data/ dir -- never data/cortex.db, which stays read-only per the
 *     contract; this is genuinely Cortex's own queue/worker/cache code
 *     running end to end, just pointed at a scratch trace store)
 *   - .env.local is never read (server.mjs is invoked directly, not via
 *     `npm start`'s --env-file-if-exists=.env.local), so no cloud API keys
 *     are even loaded -- moot anyway since the chain is filtered to `local`
 *     only, but belt and suspenders.
 * This is the real thing, not a proxy: Cortex's queue, worker, cache,
 * num_ctx-truncation-guard, and parse-failure handling all run exactly as in
 * production, just against llama3.2:3b via Ollama only. Left at its
 * documented default CORTEX_LOCAL_CONCURRENCY=1 (src/config.mjs: "the local
 * model handles exactly one call at a time") -- NOT bumped to match Arm B's
 * concurrency 4, because that concurrency=1 ceiling is itself a Cortex
 * architectural decision (MISSION.md), and this baseline is measuring
 * Cortex-local's real, documented behaviour, not an artificially sped-up one.
 *
 * Chunking + checkpoint (needed because a full 3,000-row dataset run exceeds
 * this tool's per-command timeout): each invocation submits at most --limit
 * rows, starting from wherever results/.checkpoints/<label>.cortex_local.json
 * left off, as its own Cortex relevance job (unique query_ids per row via a
 * running global index so ids never collide across chunks), polls it to
 * completion, appends to the checkpoint, and only writes the final
 * results/cortex_local__<label>.json once every row is covered. The cold
 * unload and scratch-db wipe happen only on the very first chunk (index 0);
 * later chunks reuse the same scratch db and assume the model is still warm.
 *
 * Usage: node scripts/run_cortex_local.mjs <dataset-file-relative-to-data/> <label> [--limit N]
 * Example: node scripts/run_cortex_local.mjs esci_eval_sample.jsonl esci --limit 600
 */
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateArm } from "../src/evaluate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXP_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(EXP_DIR, "data");
const RESULTS_DIR = path.join(EXP_DIR, "results");
const CHECKPOINT_DIR = path.join(RESULTS_DIR, ".checkpoints");
const CORTEX_ROOT = path.join(EXP_DIR, "..", ".."); // experiments/relevancy-replacement/../.. -> cortex/

const PORT = Number(process.env.CORTEX_LOCAL_SCRATCH_PORT || 7099);
const MODEL = process.env.CORTEX_LOCAL_MODEL || "llama3.2:3b";
const BASE_URL = `http://127.0.0.1:${PORT}`;

function stopModel() {
  try {
    execFileSync("ollama", ["stop", MODEL], { stdio: "ignore" });
    return true;
  } catch (err) {
    console.warn(`Warning: could not run 'ollama stop ${MODEL}' (${err.message}).`);
    return false;
  }
}

function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await fetch(`${BASE_URL}/v1/health`);
        if (res.ok) return resolve(true);
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error("scratch server did not become healthy in time"));
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

async function pollJob(jobId, { intervalMs = 3000, onProgress } = {}) {
  for (;;) {
    const res = await fetch(`${BASE_URL}/v1/relevance/${jobId}`);
    const job = await res.json();
    if (onProgress) onProgress(job);
    if (job.status === "complete") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function checkpointPath(label) {
  return path.join(CHECKPOINT_DIR, `${label}.cortex_local.json`);
}
function loadCheckpoint(label) {
  const p = checkpointPath(label);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return { pairs: [], timings: [], nFailed: 0, failuresSample: [], cacheHits: 0, totalElapsedS: 0, nextIndex: 0 };
}
function saveCheckpoint(label, state) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(checkpointPath(label), JSON.stringify(state));
}

async function main() {
  const args = process.argv.slice(2);
  const datasetFile = args[0];
  const label = args[1];
  const limitIdx = args.indexOf("--limit");
  const chunkLimit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : null; // chunk size, not a dataset truncation
  if (!datasetFile || !label) {
    console.error("Usage: node scripts/run_cortex_local.mjs <dataset-file> <label> [--limit N]");
    process.exit(1);
  }

  const datasetPath = path.join(DATA_DIR, datasetFile);
  const rows = readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`Dataset: ${datasetFile} (${rows.length} pairs total). Label: ${label}.`);

  const ckpt = loadCheckpoint(label);
  const start = ckpt.nextIndex;
  const end = chunkLimit ? Math.min(rows.length, start + chunkLimit) : rows.length;

  const scratchDbRelPath = path.join("experiments", "relevancy-replacement", "data", `cortex_local_scratch_${label}.db`);
  const scratchDbAbsPath = path.join(CORTEX_ROOT, scratchDbRelPath);

  if (start >= rows.length) {
    console.log(`Label ${label}: checkpoint already covers all ${rows.length} rows. Finalizing only, no new job.`);
  } else {
    console.log(`Chunk: [${start}, ${end}) of ${rows.length}.`);

    if (start === 0) {
      // Fresh run for this label -- start clean so a stale scratch db from a previous partial
      // run can't let cache hits silently skip real inference and understate latency/failures.
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(scratchDbAbsPath + suffix)) rmSync(scratchDbAbsPath + suffix);
      }
      stopModel();
      console.log(`Unloaded ${MODEL} from Ollama before starting the scratch Cortex-local server -- first call is a genuine cold load.`);
    } else {
      console.log(`Resuming at index ${start} -- reusing scratch db, model assumed warm from a prior chunk.`);
    }

    console.log(`Starting scratch Cortex server: CORTEX_PROVIDER_CHAIN=local, CORTEX_PORT=${PORT}, CORTEX_DB=${scratchDbRelPath}`);
    const child = spawn("node", ["src/server.mjs"], {
      cwd: CORTEX_ROOT,
      env: {
        ...process.env,
        CORTEX_PROVIDER_CHAIN: "local",
        CORTEX_PORT: String(PORT),
        CORTEX_DB: scratchDbRelPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverLog = "";
    child.stdout.on("data", (d) => (serverLog += d.toString()));
    child.stderr.on("data", (d) => (serverLog += d.toString()));

    try {
      await waitForHealth();
      console.log("Scratch server healthy.");

      const chunkRows = rows.slice(start, end);
      const queries = chunkRows.map((r, j) => ({
        query_id: `${label}-${start + j}`,
        query: r.query,
        products: [{ id: "p0", title: r.title }],
      }));

      const t0 = Date.now();
      const submitRes = await fetch(`${BASE_URL}/v1/relevance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "relevancy-replacement-experiment", queries }),
      });
      const submitBody = await submitRes.json();
      if (!submitRes.ok) throw new Error(`submit failed: ${JSON.stringify(submitBody)}`);
      console.log(`Submitted job ${submitBody.job_id}: ${submitBody.call_ids.length} calls queued, ${submitBody.cache.hits} cache hits.`);

      const job = await pollJob(submitBody.job_id, {
        onProgress: (j) => {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`  ${j.counts.succeeded}/${chunkRows.length} succeeded, ${j.counts.failed + j.counts.exhausted} failed, ${elapsed}s elapsed`);
        },
      });
      const chunkElapsedS = (Date.now() - t0) / 1000;

      const gradeByQueryId = new Map();
      for (const q of job.queries) {
        for (const j of q.judgments) gradeByQueryId.set(q.query_id, j.grade);
      }

      const chunkPairs = [];
      for (let j = 0; j < chunkRows.length; j++) {
        const qid = `${label}-${start + j}`;
        if (gradeByQueryId.has(qid)) {
          const r = chunkRows[j];
          const gold_grade = r.grade !== undefined ? r.grade : r.cortex_grade;
          chunkPairs.push({ query: r.query, title: r.title, gold_grade, pred_grade: gradeByQueryId.get(qid) });
        }
      }

      // Latency from the scratch db's attempts table, filtered to this chunk's job_id only
      // (each chunk submits its own job, so cross-chunk contamination is impossible here).
      const db = new DatabaseSync(scratchDbAbsPath, { readOnly: true });
      const attemptRows = db
        .prepare(
          `SELECT a.latency_ms as latency_ms
           FROM calls c JOIN attempts a
             ON a.call_id = c.id AND a.attempt_no = (SELECT MAX(a2.attempt_no) FROM attempts a2 WHERE a2.call_id = c.id)
           WHERE c.job_id = ?
           ORDER BY c.started_at ASC`,
        )
        .all(submitBody.job_id);
      db.close();
      const chunkTimings = attemptRows.map((r, i) => ({ latency_ms: r.latency_ms, cold: start === 0 && i === 0 }));

      ckpt.pairs.push(...chunkPairs);
      ckpt.timings.push(...chunkTimings);
      ckpt.nFailed += job.failures.length;
      if (ckpt.failuresSample.length < 20) ckpt.failuresSample.push(...job.failures.slice(0, 20 - ckpt.failuresSample.length));
      ckpt.cacheHits += submitBody.cache.hits;
      ckpt.totalElapsedS += chunkElapsedS;
      ckpt.nextIndex = end;
      saveCheckpoint(label, ckpt);
      console.log(`Chunk done in ${chunkElapsedS.toFixed(1)}s. Checkpoint now at ${ckpt.nextIndex}/${rows.length}.`);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (ckpt.nextIndex < rows.length) {
    console.log(`Not finalizing: ${ckpt.nextIndex}/${rows.length} done. Re-run the same command to continue.`);
    return;
  }

  // Full dataset covered -- finalize.
  const extra = {
    dataset_file: datasetFile,
    n_source_rows: rows.length,
    n_scored: ckpt.pairs.length,
    n_failed: ckpt.nFailed,
    failure_rate: rows.length > 0 ? ckpt.nFailed / rows.length : null,
    failures_sample: ckpt.failuresSample,
    cache_hits: ckpt.cacheHits,
    model: MODEL,
    provider_chain_forced: "local",
    provider_concurrency: 1,
    total_elapsed_s: ckpt.totalElapsedS,
    effective_throughput_pairs_per_sec: ckpt.totalElapsedS > 0 ? rows.length / ckpt.totalElapsedS : null,
    run_in_chunks: true,
    note: "Cortex-local, LIVE: a real second instance of src/server.mjs (unmodified) with CORTEX_PROVIDER_CHAIN=local and a scratch CORTEX_DB, never data/cortex.db. Concurrency left at Cortex's documented default of 1 for the local provider. This is the baseline every arm must beat.",
    rss_caveat: "peak_rss_bytes is null: this dataset was run across multiple separate chunked scratch-server processes, so no single process RSS represents the whole run. Ollama itself (a separate process) holds the model weights (~5-6GB RSS per `ollama ps`), not measured here.",
  };

  const result = evaluateArm({
    arm: "cortex_local",
    dataset: label,
    pairs: ckpt.pairs,
    timings: ckpt.timings,
    peakRssBytes: null,
    extra,
  });

  const outPath = path.join(RESULTS_DIR, `cortex_local__${label}.json`);
  if (existsSync(outPath)) {
    const stampedOld = outPath.replace(/\.json$/, `.superseded-${Date.now()}.json`);
    renameSync(outPath, stampedOld);
    console.log(`Existing result moved aside: ${stampedOld}`);
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(`n_scored=${ckpt.pairs.length} n_failed=${ckpt.nFailed} QWK=${result.qwk} accuracy=${result.accuracy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
