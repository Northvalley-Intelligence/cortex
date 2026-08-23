#!/usr/bin/env python3
"""
Batch inference driver for Arm C (fine-tuned bge-reranker-v2-m3), invoked as a
single subprocess by arms/bge_reranker.mjs (one process per run_arm.mjs
invocation: load model once, score every pair in the dataset, exit). This
keeps the harness contract (arms/*.mjs export a synchronous predict(pairs))
intact while running the actual inference in Python/torch.

Usage: python3 bge_infer.py <model_dir> <input_pairs.jsonl> <output.json>

Input JSONL: one {"query": ..., "title": ...} object per line, in order.
Output JSON: {
  "predictions": [{"pred_grade": int, "latency_ms": float, "cold": bool}, ...]  (same order/length as input),
  "peak_rss_bytes": int,       -- resource.getrusage high-water mark for this process (real, not null)
  "model_load_s": float,
  "total_elapsed_s": float,
}

Latency methodology: each pair is timed as its OWN model.predict() call
(batch_size=1), matching how Arm B (ollama_prompt) and Arm A (bm25) report
latency -- one real end-to-end call per pair, not an amortized batch/N. The
first pair is flagged cold=true (first MPS kernel dispatch after the model is
already resident); every other pair is warm.
"""
import json
import resource
import sys
import time

from sentence_transformers import CrossEncoder


def main():
    model_dir, input_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(input_path) as f:
        pairs = [json.loads(l) for l in f if l.strip()]

    t_load0 = time.time()
    model = CrossEncoder(model_dir, device="mps")
    model.model.eval()
    model_load_s = time.time() - t_load0

    predictions = []
    t_total0 = time.time()
    import torch

    with torch.no_grad():
        for i, pair in enumerate(pairs):
            t0 = time.time()
            logits = model.predict(
                [(pair["query"], pair["title"])],
                batch_size=1,
                show_progress_bar=False,
                apply_softmax=False,
                convert_to_numpy=True,
            )
            pred_grade = int(logits[0].argmax())
            latency_ms = (time.time() - t0) * 1000
            predictions.append({"pred_grade": pred_grade, "latency_ms": latency_ms, "cold": i == 0})
    total_elapsed_s = time.time() - t_total0

    # macOS: ru_maxrss is already in bytes (Linux would report KB -- this script is
    # written for this experiment's target machine, an Apple M5, so bytes is correct here).
    peak_rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    out = {
        "predictions": predictions,
        "peak_rss_bytes": peak_rss_bytes,
        "model_load_s": model_load_s,
        "total_elapsed_s": total_elapsed_s,
        "n_pairs": len(pairs),
    }
    with open(output_path, "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
