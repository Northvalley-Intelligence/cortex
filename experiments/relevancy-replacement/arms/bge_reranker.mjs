/**
 * Arm C -- bge-reranker-v2-m3 fine-tuned on ESCI (handoff 03).
 *
 * Inference runs in Python/torch (scripts/bge_infer.py), not in this process --
 * sentence-transformers/torch have no Node equivalent here, and this experiment's
 * Python tooling (requirements.txt, .venv) already exists for the ESCI/WANDS
 * download+mapping pipeline. This module's `predict(pairs)` is a thin SYNCHRONOUS
 * wrapper (matching every other arm's contract, which scripts/run_arm.mjs calls
 * without awaiting): it writes the pairs to a scratch jsonl, spawns ONE Python
 * subprocess that loads the fine-tuned model once and scores every pair --
 * timing each pair as its own model.predict() call (batch_size=1), same
 * methodology as Arm A/B -- and reads the result back synchronously
 * (child_process.spawnSync).
 *
 * Harness RSS fix (handoff 03, "fix the harness ... latency/parse-failure
 * fields"): the Node process running run_arm.mjs never touches the model, so
 * process.memoryUsage() there would report near-nothing -- not the real
 * footprint. This module exports getPeakRssBytes(), which run_arm.mjs uses
 * INSTEAD of its own measurement when present, sourced from the Python
 * subprocess's own resource.getrusage() high-water mark (real, not null,
 * unlike the ollama_prompt arm's peak_rss_bytes: null for its multi-process
 * chunked run).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ARM_NAME = "bge_reranker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MODEL_DIR = path.join(ROOT, "models", "bge-esci");
const PYTHON = path.join(ROOT, ".venv", "bin", "python3");
const INFER_SCRIPT = path.join(ROOT, "scripts", "bge_infer.py");
const TMP_DIR = path.join(ROOT, "data", ".bge_tmp");

let _lastPeakRssBytes = null;
let _lastExtra = null;

export function predict(pairs) {
  if (!existsSync(MODEL_DIR)) {
    throw new Error(
      `Fine-tuned model not found at ${MODEL_DIR}. Run scripts/prepare_bge_train_subset.mjs then scripts/train_bge.py first (see 06-arm-c-bge.md for the reproduce steps).`,
    );
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const inputPath = path.join(TMP_DIR, `input-${process.pid}-${Date.now()}.jsonl`);
  const outputPath = path.join(TMP_DIR, `output-${process.pid}-${Date.now()}.json`);

  const lines = pairs.map((p) => JSON.stringify({ query: p.query, title: p.title }));
  writeFileSync(inputPath, lines.join("\n") + "\n", "utf8");

  const result = spawnSync(PYTHON, [INFER_SCRIPT, MODEL_DIR, inputPath, outputPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    rmSync(inputPath, { force: true });
    throw new Error(`bge_infer.py exited with status ${result.status}${result.error ? `: ${result.error}` : ""}`);
  }

  const out = JSON.parse(readFileSync(outputPath, "utf8"));
  rmSync(inputPath, { force: true });
  rmSync(outputPath, { force: true });

  if (out.predictions.length !== pairs.length) {
    throw new Error(`bge_infer.py returned ${out.predictions.length} predictions for ${pairs.length} input pairs`);
  }

  _lastPeakRssBytes = out.peak_rss_bytes;
  _lastExtra = {
    model: "BAAI/bge-reranker-v2-m3 (fine-tuned on ESCI, models/bge-esci)",
    model_load_s: out.model_load_s,
    total_elapsed_s: out.total_elapsed_s,
    parse_failure_count: 0,
    parse_failure_rate: 0,
    parse_failure_note: "not applicable -- argmax over a 4-way classification head, no free-text parsing",
    rss_source: "python subprocess resource.getrusage(RUSAGE_SELF).ru_maxrss (real process, not the Node harness process)",
  };

  return out.predictions;
}

/** Used by run_arm.mjs INSTEAD OF process.memoryUsage() when present -- see module docstring. */
export function getPeakRssBytes() {
  return _lastPeakRssBytes;
}

/** Merged into the result's `extra` field by run_arm.mjs when present. */
export function getExtra() {
  return _lastExtra ?? {};
}
