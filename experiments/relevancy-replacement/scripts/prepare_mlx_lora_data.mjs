#!/usr/bin/env node
/**
 * Build mlx_lm.lora training data for Arm D (handoff 04). Reuses the SAME
 * balanced 36k-train / 4k-dev ESCI subset Arm C (bge fine-tune) used --
 * data/bge_train_subset.jsonl + data/bge_dev_subset.jsonl -- rather than
 * re-sampling, since that subset is already proven leakage-free (source is
 * esci_train.jsonl, the query-disjoint TRAIN split; journal 02/06) and using
 * the identical rows keeps Arm C vs Arm D an apples-to-apples comparison of
 * METHOD, not of training data.
 *
 * mlx_lm.lora's CompletionsDataset expects {"prompt":..., "completion":...}
 * per line, in a directory with train.jsonl / valid.jsonl (test.jsonl
 * optional -- not written here; this experiment's own harness, not
 * mlx_lm's --test, is what evaluates the arm). Each row's prompt/completion
 * come from src/mlxPrompt.mjs, which imports RELEVANCE_SCALE from Cortex.
 *
 * Also writes data/mlx_lora_data/prompt_template.txt -- the exact template
 * (with __QUERY__/__TITLE__ placeholders) mlx_infer.py reads at inference
 * time, so train-time and inference-time prompts are byte-identical without
 * duplicating the scale text in Python (see src/mlxPrompt.mjs docstring).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPrompt, promptTemplate, LABEL_TOKENS } from "../src/mlxPrompt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_DIR = path.join(DATA_DIR, "mlx_lora_data");

function loadJsonl(p) {
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function toRecord(row) {
  if (!LABEL_TOKENS.includes(String(row.grade))) {
    throw new Error(`Grade ${row.grade} not in LABEL_TOKENS ${LABEL_TOKENS.join(",")} -- row: ${JSON.stringify(row)}`);
  }
  return { prompt: buildPrompt(row.query, row.title), completion: String(row.grade) };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const trainSrc = path.join(DATA_DIR, "bge_train_subset.jsonl");
  const devSrc = path.join(DATA_DIR, "bge_dev_subset.jsonl");
  const trainRows = loadJsonl(trainSrc);
  const devRows = loadJsonl(devSrc);

  const trainOut = trainRows.map(toRecord);
  const validOut = devRows.map(toRecord);

  writeFileSync(path.join(OUT_DIR, "train.jsonl"), trainOut.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(path.join(OUT_DIR, "valid.jsonl"), validOut.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(path.join(OUT_DIR, "prompt_template.txt"), promptTemplate(), "utf8");

  const meta = {
    source_train: "data/bge_train_subset.jsonl (same balanced ESCI subset as Arm C -- journal 06)",
    source_valid: "data/bge_dev_subset.jsonl",
    n_train: trainOut.length,
    n_valid: validOut.length,
    label_tokens: LABEL_TOKENS,
    format: "mlx_lm CompletionsDataset: {\"prompt\":..., \"completion\":...}, one grade digit per completion, trained with --mask-prompt so loss is only on the completion + eos token",
    prompt_template_file: "prompt_template.txt (placeholders __QUERY__/__TITLE__; mlx_infer.py reads this file verbatim -- see src/mlxPrompt.mjs)",
  };
  writeFileSync(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

  console.log(`Wrote ${trainOut.length} train / ${validOut.length} valid rows to ${OUT_DIR}`);
  console.log(`Sample train record: ${JSON.stringify(trainOut[0])}`);
}

main();
