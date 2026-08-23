#!/usr/bin/env python3
"""
Batch inference driver for Arm D (Llama-3.2-3B + LoRA, mlx_lm), invoked as a
single subprocess by arms/mlx_lora.mjs (one process per run_arm.mjs
invocation: load base+adapter once, score every pair, exit), mirroring
scripts/bge_infer.py's contract so the harness (arms/*.mjs export a
synchronous predict(pairs)) is unchanged.

Unlike bge_infer.py (a 4-way classification head), this arm is a base
CAUSAL-LM: inference does ONE forward pass per pair and reads the
NEXT-TOKEN LOGITS at the final prompt position, restricted to the four
label-digit tokens ("0".."3"), argmax -> grade. It NEVER calls
mlx_lm.generate / free-generates text -- no text parsing, so there is no
parse-failure rate to report (same reasoning bge_infer.py gives for its
own argmax-over-logits, just applied to a causal LM's vocab instead of a
4-way head).

Usage: python3 mlx_infer.py <model_id_or_path> <adapter_path_or_none> <input_pairs.jsonl> <output.json>

Input JSONL: one {"query": ..., "title": ...} object per line, in order.
Output JSON: {
  "predictions": [{"pred_grade": int, "latency_ms": float, "cold": bool}, ...],
  "peak_rss_bytes": int,
  "model_load_s": float,
  "total_elapsed_s": float,
  "label_logits_sample": [...]   -- first pair's raw 4 label logits, for smoke-test sanity
}

Prompt: rendered from data/mlx_lora_data/prompt_template.txt (placeholders
__QUERY__/__TITLE__), the SAME file scripts/prepare_mlx_lora_data.mjs wrote
for LoRA training -- guarantees train-time and inference-time prompts are
byte-identical (src/mlxPrompt.mjs). Label token ids are looked up from the
tokenizer at load time via tokenizer.encode(digit, add_special_tokens=False)
for each digit in data/mlx_lora_data/meta.json's label_tokens (itself sourced
from Cortex's RELEVANCE_SCALE, never hardcoded here) -- NOT hardcoded ids,
so a different base model/tokenizer would still be handled correctly.

Latency methodology: each pair is timed as its own forward pass (batch=1),
matching Arm A/B/C. First pair flagged cold=true (first real MLX/Metal
kernel dispatch after the model is resident); every other pair is warm.
"""
import json
import resource
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LORA_DATA_DIR = ROOT / "data" / "mlx_lora_data"


def load_prompt_template():
    template_path = LORA_DATA_DIR / "prompt_template.txt"
    meta_path = LORA_DATA_DIR / "meta.json"
    if not template_path.exists() or not meta_path.exists():
        raise SystemExit(
            f"Missing {template_path} or {meta_path} -- run "
            "`node scripts/prepare_mlx_lora_data.mjs` first."
        )
    template = template_path.read_text()
    meta = json.loads(meta_path.read_text())
    return template, meta["label_tokens"]


def render_prompt(template, query, title):
    return template.replace("__QUERY__", query).replace("__TITLE__", title)


def main():
    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: python3 mlx_infer.py <model_id_or_path> <adapter_path_or_none> "
            "<input_pairs.jsonl> <output.json>"
        )
    model_id, adapter_path, input_path, output_path = sys.argv[1:5]
    adapter_path = None if adapter_path in ("", "none", "None") else adapter_path

    template, label_tokens = load_prompt_template()

    with open(input_path) as f:
        pairs = [json.loads(l) for l in f if l.strip()]

    t_load0 = time.time()
    from mlx_lm import load
    import mlx.core as mx

    load_kwargs = {}
    if adapter_path:
        load_kwargs["adapter_path"] = adapter_path
    model, tokenizer = load(model_id, **load_kwargs)
    model.eval()

    # Resolve each label digit to its (single) token id via the real tokenizer,
    # never hardcoded -- fails loudly if a digit ever tokenizes to >1 token
    # (verified 1-token for mlx-community/Llama-3.2-3B-Instruct-4bit; see
    # src/mlxPrompt.mjs docstring), since a >1-token label would silently break
    # the "read the logit at one position" contract.
    label_token_ids = []
    for digit in label_tokens:
        ids = tokenizer.encode(digit, add_special_tokens=False)
        if len(ids) != 1:
            raise SystemExit(f"Label token {digit!r} encodes to {ids}, expected exactly 1 token id")
        label_token_ids.append(ids[0])

    model_load_s = time.time() - t_load0

    predictions = []
    label_logits_sample = None
    t_total0 = time.time()
    for i, pair in enumerate(pairs):
        prompt_text = render_prompt(template, pair["query"], pair["title"])
        input_ids = tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt_text}],
            add_generation_prompt=True,
        )
        t0 = time.time()
        x = mx.array(input_ids)[None]
        logits = model(x)
        last = logits[0, -1, :]
        label_logits = [float(last[tid]) for tid in label_token_ids]
        mx.eval(label_logits)
        latency_ms = (time.time() - t0) * 1000
        pred_idx = max(range(len(label_logits)), key=lambda k: label_logits[k])
        pred_grade = int(label_tokens[pred_idx])
        if i == 0:
            label_logits_sample = label_logits
        predictions.append({"pred_grade": pred_grade, "latency_ms": latency_ms, "cold": i == 0})
    total_elapsed_s = time.time() - t_total0

    # macOS: ru_maxrss is already bytes (this experiment targets an Apple M-series machine).
    peak_rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    out = {
        "predictions": predictions,
        "peak_rss_bytes": peak_rss_bytes,
        "model_load_s": model_load_s,
        "total_elapsed_s": total_elapsed_s,
        "n_pairs": len(pairs),
        "label_logits_sample": label_logits_sample,
        "adapter_path": adapter_path,
        "model_id": model_id,
    }
    with open(output_path, "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
