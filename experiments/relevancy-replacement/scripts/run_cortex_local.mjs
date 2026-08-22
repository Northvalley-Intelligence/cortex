#!/usr/bin/env node
/**
 * Score Cortex-LOCAL, LIVE, on an eval sample -- the baseline the fine-tuned
 * arms (C/D) must beat (handoff 01: "score Cortex-local live on the two
 * seeded samples ... force CORTEX_PROVIDER_CHAIN to local ... do NOT edit
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
 * production, just against llama3.2:3b via Ollama only.
 *
 * Submits the WHOLE dataset as one relevance job (one query_id per pair, one
 * product per query -- a degenerate 1-item ranking; per-pair grade is what
 * this arm-comparison needs, not Cortex's own per-query NDCG, which this
 * experiment's own harness computes independently), polls until complete,
 * reads per-call latency from the scratch db's `attempts` table (same join
 * scripts/extract_cortex_validations.mjs uses), and writes
 * results/cortex_local__<label>.json via the same evaluateArm() + no-silent-
 * overwrite convention as the other arm runners.
 *
 * Usage: node scripts/run_cortex_local.mjs <dataset-file-relative-to-data/> <label> [--limit N]
 * Example: node scripts/run_cortex_local.mjs esci_eval_sample.jsonl esci
 */
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateArm } from "../src/evaluate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXP_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(EXP_DIR, "data");
const RESULTS_DIR = path.join(EXP_DIR, "results");
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

async function main() {
  const args = process.argv.slice(2);
  const datasetFile = args[0];
  const label = args[1];
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : null;
  if (!datasetFile || !label) {
    console.error("Usage: node scripts/run_cortex_local.mjs <dataset-file> <label> [--limit N]");
    process.exit(1);
  }

  const datasetPath = path.join(DATA_DIR, datasetFile);
  const lines = readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean);
  let rows = lines.map((l) => JSON.parse(l));
  if (limit) rows = rows.slice(0, limit);
  console.log(`Dataset: ${datasetFile} (${rows.length} pairs). Label: ${label}.`);

  const scratchDbRelPath = path.join("experiments", "relevancy-replacement", "data", `cortex_local_scratch_${label}.db`);
  const scratchDbAbsPath = path.join(CORTEX_ROOT, scratchDbRelPath);
  // Start clean -- a stale scratch db from a previous partial run would let
  // cache hits silently skip real inference and understate latency/failure rate.
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(scratchDbAbsPath + suffix)) rmSync(scratchDbAbsPath + suffix);
  }

  stopModel();
  console.log(`Unloaded ${MODEL} from Ollama before starting the scratch Cortex-local server -- first call is a genuine cold load.`);

  console.log(`Starting scratch Cortex server: CORTEX_PROVIDER_CHAIN=local, CORTEX_PORT=${PORT}, CORTEX_DB=${scratchDbRelPath}`);
  const child = spawn(
    "node",
    ["src/server.mjs"],
    {
      cwd: CORTEX_ROOT,
      env: {
        ...process.env,
        CORTEX_PROVIDER_CHAIN: "local",
        CORTEX_PORT: String(PORT),
        CORTEX_DB: scratchDbRelPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d.toString()));
  child.stderr.on("data", (d) => (serverLog += d.toString()));

  try {
    await waitForHealth();
    console.log("Scratch server healthy.");
    console.log(serverLog.trim());

    const queries = rows.map((r, i) => ({
      query_id: `${label}-${i}`,
      query: r.query,
      products: [{ id: "p0", title: r.title }],
    }));

    const submitRes = await fetch(`${BASE_URL}/v1/relevance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "relevancy-replacement-experiment", queries }),
    });
    const submitBody = await submitRes.json();
    if (!submitRes.ok) throw new Error(`submit failed: ${JSON.stringify(submitBody)}`);
    console.log(`Submitted job ${submitBody.job_id}: ${submitBody.call_ids.length} calls queued, ${submitBody.cache.hits} cache hits.`);

    const t0 = Date.now();
    const job = await pollJob(submitBody.job_id, {
      onProgress: (j) => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ${j.counts.succeeded}/${rows.length} succeeded, ${j.counts.failed + j.counts.exhausted} failed, ${elapsed}s elapsed`);
      },
    });

    // Build query_id -> pred_grade from the job's own judgments (Cortex already refuses to
    // coerce an unparseable output to a grade -- it lands in job.failures instead).
    const gradeByQueryId = new Map();
    for (const q of job.queries) {
      for (const j of q.judgments) gradeByQueryId.set(q.query_id, j.grade);
    }
    const failedQueryIds = new Set(job.failures.map((f) => f.query_id));

    const pairs = [];
    for (let i = 0; i < rows.length; i++) {
      const qid = `${label}-${i}`;
      if (gradeByQueryId.has(qid)) {
        const gold_grade = rows[i].grade !== undefined ? rows[i].grade : rows[i].cortex_grade;
        pairs.push({ query: rows[i].query, title: rows[i].title, gold_grade, pred_grade: gradeByQueryId.get(qid) });
      }
    }

    // Latency from the scratch db's attempts table (same shape/join as
    // scripts/extract_cortex_validations.mjs). Only FRESH calls have an attempts row; a cache
    // hit (possible if the sample contains a duplicate (query,title) pair) has none and is
    // excluded from speed stats, counted separately in `extra.cache_hits`.
    const db = new DatabaseSync(scratchDbAbsPath, { readOnly: true });
    const attemptRows = db
      .prepare(
        `SELECT c.id as call_id, c.started_at as call_started_at, a.latency_ms as latency_ms
         FROM calls c JOIN attempts a
           ON a.call_id = c.id AND a.attempt_no = (SELECT MAX(a2.attempt_no) FROM attempts a2 WHERE a2.call_id = c.id)
         WHERE c.job_id = ?
         ORDER BY c.started_at ASC`,
      )
      .all(submitBody.job_id);
    db.close();

    const timings = attemptRows.map((r, i) => ({ latency_ms: r.latency_ms, cold: i === 0 }));

    const extra = {
      dataset_file: datasetFile,
      n_source_rows: rows.length,
      n_scored: pairs.length,
      n_failed: job.failures.length,
      failure_rate: rows.length > 0 ? job.failures.length / rows.length : null,
      failures_sample: job.failures.slice(0, 20),
      cache_hits: submitBody.cache.hits,
      model: MODEL,
      provider_chain_forced: "local",
      note: "Cortex-local, LIVE: a real second instance of src/server.mjs (unmodified) with CORTEX_PROVIDER_CHAIN=local and a scratch CORTEX_DB, never data/cortex.db. This is the baseline Arms C/D must beat.",
    };

    const rssBefore = process.memoryUsage().rss;
    const result = evaluateArm({
      arm: "cortex_local",
      dataset: label,
      pairs,
      timings,
      peakRssBytes: rssBefore, // control-plane only -- see extra.rss_caveat
      extra: {
        ...extra,
        rss_caveat: "peak_rss_bytes is this script's own memory, not Ollama's (a separate process holds the model weights, ~2-5GB RSS per `ollama ps`); not measured here, same limitation applies to arms/ollama_prompt.mjs.",
      },
    });

    const outPath = path.join(RESULTS_DIR, `cortex_local__${label}.json`);
    if (existsSync(outPath)) {
      const stampedOld = outPath.replace(/\.json$/, `.superseded-${Date.now()}.json`);
      renameSync(outPath, stampedOld);
      console.log(`Existing result moved aside: ${stampedOld}`);
    }
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`Wrote ${outPath}`);
    console.log(`n_scored=${pairs.length} n_failed=${job.failures.length} QWK=${result.qwk} accuracy=${result.accuracy}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
