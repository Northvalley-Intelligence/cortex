#!/usr/bin/env python3
"""
Round-2 GPU judge (CPU vs GPU Battle) -- prompted LLM-as-judge on a real GPU.

Answers the open question from Round 1: is the ~0.3-0.5 QWK ceiling the TASK or the
MODEL SIZE? Round 1's prompted arm (B) used llama3.2:3b on Apple Metal. This runs a
BIGGER prompted judge on an NVIDIA GPU with the method held constant, so any movement
in QWK is attributable to model scale (family caveat noted in the journal when the
fallback Qwen model is used instead of Llama-3.1-8B).

Held CONSTANT vs Round-1 Arm B (arms/ollama_prompt.mjs + src/relevance.mjs):
  * SAME judge system prompt  -- read byte-for-byte from --system-prompt file, which is
    the output of buildJudgeSystemPrompt(null) (Cortex frame + DEFAULT_JUDGE_RUBRIC).
  * SAME per-pair user prompt  -- buildJudgePrompt({query, product:{title}}) replicated
    exactly in build_user_prompt() below.
  * SAME parser  -- parse_judgment() is a line-for-line port of parseJudgment()
    (src/relevance.mjs): strips <think>/fences, first-{ to last-}, integer grade in
    {0,1,2,3}, and RAISES on anything else. A parse failure is recorded as a FAILURE and
    EXCLUDED from QWK -- NEVER coerced to 0 (contract rule, 00-cortex-contract.md).
  * SAME eval sets  -- esci_eval_sample.jsonl / wands_eval_sample.jsonl (3000 rows each),
    the exact held-out files the Round-1 arms scored on.
  * SAME QWK  -- quadratic_weighted_kappa() ports quadraticWeightedKappa()
    (src/evaluate.mjs) with minGrade=0, maxGrade=3 (n=4), so numbers line up beside the
    Round-1 table.

Only difference from Arm B: model + hardware (bigger model, NVIDIA GPU via vLLM chat,
which applies the model's own instruct chat template -- same shape as Ollama applying
llama3.2's template for Arm B).
"""
import argparse
import gzip
import json
import re
import sys
import time

# ---- Parser: line-for-line port of parseJudgment (src/relevance.mjs) --------------
VALID_GRADES = {0, 1, 2, 3}
_THINK = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_FENCE_OPEN = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)
_FENCE_CLOSE = re.compile(r"```\s*$", re.IGNORECASE)


class ParseFailure(Exception):
    pass


def parse_judgment(text):
    """Port of parseJudgment: returns int grade or raises ParseFailure. Never returns a default."""
    if not text or not isinstance(text, str):
        raise ParseFailure("judge returned no text")
    cleaned = _THINK.sub("", text).strip()
    cleaned = _FENCE_CLOSE.sub("", _FENCE_OPEN.sub("", cleaned)).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ParseFailure(f"judge response contained no JSON object: {text[:120]}")
    try:
        parsed = json.loads(cleaned[start:end + 1])
    except Exception as err:  # noqa: BLE001
        raise ParseFailure(f"judge response was not valid JSON: {err}")
    grade = parsed.get("grade") if isinstance(parsed, dict) else None
    # Number(parsed.grade) + Number.isInteger + (grade in RELEVANCE_SCALE)
    if isinstance(grade, bool):
        raise ParseFailure(f"judge returned grade {json.dumps(grade)}, outside the 0-3 scale")
    try:
        gf = float(grade)
    except (TypeError, ValueError):
        raise ParseFailure(f"judge returned grade {json.dumps(grade)}, outside the 0-3 scale")
    if gf != int(gf) or int(gf) not in VALID_GRADES:
        raise ParseFailure(f"judge returned grade {json.dumps(grade)}, outside the 0-3 scale")
    reason = parsed.get("reason") if isinstance(parsed, dict) else None
    return int(gf), (reason if isinstance(reason, str) else None)


# ---- Prompt: exact port of buildJudgePrompt (src/relevance.mjs) --------------------
def build_user_prompt(query, title):
    return "\n".join([
        f"Search query: {query}",
        f"Product title: {title}",
        "",
        "Grade this product's relevance to the query.",
    ])


# ---- QWK: exact port of quadraticWeightedKappa (src/evaluate.mjs) ------------------
def quadratic_weighted_kappa(gold, pred, min_grade=0, max_grade=3):
    n = max_grade - min_grade + 1
    conf = [[0] * n for _ in range(n)]
    for g, p in zip(gold, pred):
        conf[g - min_grade][p - min_grade] += 1
    gold_hist = [0] * n
    pred_hist = [0] * n
    for i in range(n):
        for j in range(n):
            gold_hist[i] += conf[i][j]
            pred_hist[j] += conf[i][j]
    total = len(gold)
    if total == 0:
        return None
    weights = [[((i - j) ** 2) / (((n - 1) ** 2) or 1) for j in range(n)] for i in range(n)]
    num = 0.0
    den = 0.0
    for i in range(n):
        for j in range(n):
            observed = conf[i][j] / total
            expected = (gold_hist[i] * pred_hist[j]) / (total * total)
            num += weights[i][j] * observed
            den += weights[i][j] * expected
    if den == 0:
        return 1.0 if num == 0 else 0.0
    return 1 - num / den, conf


def qwk_only(gold, pred):
    r = quadratic_weighted_kappa(gold, pred)
    return r[0] if isinstance(r, tuple) else r


def exact_accuracy(gold, pred):
    return sum(1 for g, p in zip(gold, pred) if g == p) / len(gold) if gold else None


def off_by_one(gold, pred):
    return sum(1 for g, p in zip(gold, pred) if abs(g - p) <= 1) / len(gold) if gold else None


def mae(gold, pred):
    return sum(abs(g - p) for g, p in zip(gold, pred)) / len(gold) if gold else None


def bootstrap_ci(gold, pred, resamples=1000, seed=42):
    """95% CI on QWK. NOTE: numpy bootstrap (not the JS mulberry32 PRNG), so the CI method
    differs from Round-1; the QWK POINT ESTIMATE is computed by the identical formula and is
    directly comparable. CI is for context only."""
    import random
    rng = random.Random(seed)
    n = len(gold)
    if n == 0:
        return {"low": None, "high": None, "resamples": resamples, "method": "python-random-bootstrap"}
    scores = []
    for _ in range(resamples):
        idx = [rng.randrange(n) for _ in range(n)]
        gs = [gold[i] for i in idx]
        ps = [pred[i] for i in idx]
        q = qwk_only(gs, ps)
        if q is not None:
            scores.append(q)
    scores.sort()
    lo = scores[int(0.025 * len(scores))]
    hi = scores[min(len(scores) - 1, int(0.975 * len(scores)) - 1)]
    return {"low": lo, "high": hi, "resamples": resamples, "method": "python-random-bootstrap"}


def load_jsonl(path):
    opener = gzip.open if path.endswith(".gz") else open
    rows = []
    with opener(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--system-prompt", required=True, help="file with the exact composed judge system prompt")
    ap.add_argument("--dataset", action="append", required=True,
                    help="name=path.jsonl[.gz]; repeatable (e.g. esci=/data/esci.jsonl.gz)")
    ap.add_argument("--limit", type=int, default=0, help="cap rows per dataset (0 = all)")
    ap.add_argument("--max-model-len", type=int, default=4096)
    ap.add_argument("--dtype", default="auto")
    args = ap.parse_args()

    with open(args.system_prompt, "r", encoding="utf-8") as fh:
        system_prompt = fh.read()
    print(f"[gpu_judge] system prompt: {len(system_prompt)} chars", file=sys.stderr, flush=True)

    from vllm import LLM, SamplingParams
    load_t0 = time.time()
    llm = LLM(model=args.model, dtype=args.dtype, max_model_len=args.max_model_len,
              gpu_memory_utilization=0.90, enforce_eager=False)
    load_secs = time.time() - load_t0
    print(f"[gpu_judge] model loaded in {load_secs:.1f}s", file=sys.stderr, flush=True)

    # temperature 0 (greedy), max 120 new tokens -- matches Arm B (temperature:0, num_predict:120)
    sampling = SamplingParams(temperature=0.0, max_tokens=120)

    report = {
        "round": 2,
        "arm": "gpu_prompt",
        "model": args.model,
        "hardware": "NVIDIA GPU (NRP/Nautilus) via vLLM chat",
        "method": "prompted LLM-as-judge, SAME prompt+parser+QWK as Round-1 Arm B",
        "model_load_secs": round(load_secs, 1),
        "datasets": {},
    }

    for spec in args.dataset:
        name, path = spec.split("=", 1)
        rows = load_jsonl(path)
        if args.limit:
            rows = rows[:args.limit]
        print(f"[gpu_judge] {name}: {len(rows)} rows from {path}", file=sys.stderr, flush=True)

        messages = [
            [{"role": "system", "content": system_prompt},
             {"role": "user", "content": build_user_prompt(r["query"], r["title"])}]
            for r in rows
        ]
        gen_t0 = time.time()
        try:
            outputs = llm.chat(messages, sampling)
        except TypeError:
            # older/newer vLLM signature differences
            outputs = llm.chat(messages=messages, sampling_params=sampling)
        gen_secs = time.time() - gen_t0

        gold, pred = [], []
        failures = []
        pred_dist = {0: 0, 1: 0, 2: 0, 3: 0}
        for i, (r, out) in enumerate(zip(rows, outputs)):
            text = out.outputs[0].text if out.outputs else ""
            try:
                grade, _reason = parse_judgment(text)
            except ParseFailure as pf:
                failures.append({
                    "index": i, "query": r["query"], "title": r["title"],
                    "gold_grade": r["grade"], "error": str(pf), "raw": text[:200],
                })
                continue
            gold.append(int(r["grade"]))
            pred.append(grade)
            pred_dist[grade] += 1

        qwk_res = quadratic_weighted_kappa(gold, pred) if gold else None
        if isinstance(qwk_res, tuple):
            qwk, confusion = qwk_res
        else:
            qwk, confusion = qwk_res, None

        report["datasets"][name] = {
            "dataset_file": path.split("/")[-1],
            "n_source_rows": len(rows),
            "n_attempted": len(rows),
            "n_parsed": len(gold),
            "parse_failure_count": len(failures),
            "parse_failure_rate": (len(failures) / len(rows)) if rows else None,
            "qwk": qwk,
            "qwk_ci95": bootstrap_ci(gold, pred) if gold else None,
            "accuracy": exact_accuracy(gold, pred),
            "off_by_one_accuracy": off_by_one(gold, pred),
            "mae": mae(gold, pred),
            "pred_grade_distribution": pred_dist,
            "confusion_gold_by_pred": confusion,
            "gen_wall_secs": round(gen_secs, 1),
            "pairs_per_sec": round(len(rows) / gen_secs, 2) if gen_secs else None,
            "parse_failures_sample": failures[:10],
        }
        print(f"[gpu_judge] {name}: QWK={qwk} n_parsed={len(gold)} fails={len(failures)} "
              f"({gen_secs:.1f}s, {len(rows)/gen_secs:.1f} pairs/s)", file=sys.stderr, flush=True)

    print("=" * 60 + " RESULTS_JSON_BEGIN")
    print(json.dumps(report, indent=2))
    print("RESULTS_JSON_END " + "=" * 60)


if __name__ == "__main__":
    main()
