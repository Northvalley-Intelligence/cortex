/**
 * Arm D -- Llama-3.2-3B fine-tuned with LoRA (mlx_lm.lora), inference reads
 * the LABEL-TOKEN LOGITS (handoff 04). Never free-generates text: one
 * forward pass per (query, title) pair, argmax over the four grade-digit
 * token logits at the final prompt position.
 *
 * Same subprocess pattern as arms/bge_reranker.mjs, for the same reason:
 * mlx_lm/mlx have no Node equivalent here. This module's predict(pairs) is
 * a thin SYNCHRONOUS wrapper (matching every arm's contract, which
 * scripts/run_arm.mjs calls without awaiting) -- writes pairs to a scratch
 * jsonl, spawns ONE Python subprocess (scripts/mlx_infer.py) that loads the
 * base model + LoRA adapter once and scores every pair (timing each pair as
 * its own forward-pass call), reads the result back synchronously
 * (child_process.spawnSync).
 *
 * Base model: BASE_MODEL below (mlx-community 4-bit quant, per journal 07).
 * Adapter: models/llama32-3b-lora-esci/adapters.safetensors, produced by
 * `mlx_lm.lora --train` (see journal 07 for the exact command). If the
 * adapter does not exist yet, predict() runs the BASE (un-adapted) model --
 * this is intentional so the smoke-test step (handoff 04 acceptance
 * criterion 1) can prove the logit-read plumbing BEFORE training finishes,
 * and is reported via getExtra().adapter_used = false so a result run
 * against the base model is never confused with the fine-tuned arm.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ARM_NAME = "mlx_lora";
export const BASE_MODEL = "mlx-community/Llama-3.2-3B-Instruct-4bit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ADAPTER_DIR = path.join(ROOT, "models", "llama32-3b-lora-esci");
const PYTHON = path.join(ROOT, ".venv", "bin", "python3");
const INFER_SCRIPT = path.join(ROOT, "scripts", "mlx_infer.py");
const TMP_DIR = path.join(ROOT, "data", ".mlx_tmp");

let _lastPeakRssBytes = null;
let _lastExtra = null;

export function predict(pairs) {
  const adapterReady = existsSync(path.join(ADAPTER_DIR, "adapters.safetensors"));
  mkdirSync(TMP_DIR, { recursive: true });
  const inputPath = path.join(TMP_DIR, `input-${process.pid}-${Date.now()}.jsonl`);
  const outputPath = path.join(TMP_DIR, `output-${process.pid}-${Date.now()}.json`);

  const lines = pairs.map((p) => JSON.stringify({ query: p.query, title: p.title }));
  writeFileSync(inputPath, lines.join("\n") + "\n", "utf8");

  const args = [
    INFER_SCRIPT,
    BASE_MODEL,
    adapterReady ? ADAPTER_DIR : "none",
    inputPath,
    outputPath,
  ];
  const result = spawnSync(PYTHON, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    rmSync(inputPath, { force: true });
    throw new Error(`mlx_infer.py exited with status ${result.status}${result.error ? `: ${result.error}` : ""}`);
  }

  const out = JSON.parse(readFileSync(outputPath, "utf8"));
  rmSync(inputPath, { force: true });
  rmSync(outputPath, { force: true });

  if (out.predictions.length !== pairs.length) {
    throw new Error(`mlx_infer.py returned ${out.predictions.length} predictions for ${pairs.length} input pairs`);
  }

  _lastPeakRssBytes = out.peak_rss_bytes;
  _lastExtra = {
    model: `${BASE_MODEL}${adapterReady ? " + LoRA adapter (models/llama32-3b-lora-esci)" : " (BASE, NO ADAPTER -- smoke test / pre-training run)"}`,
    adapter_used: adapterReady,
    model_load_s: out.model_load_s,
    total_elapsed_s: out.total_elapsed_s,
    parse_failure_count: 0,
    parse_failure_rate: 0,
    parse_failure_note: "not applicable -- argmax over the 4 label-digit token logits at one forward-pass position, no free-generation or text parsing",
    label_logits_sample_first_pair: out.label_logits_sample,
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
