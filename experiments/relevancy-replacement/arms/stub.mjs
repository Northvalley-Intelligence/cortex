/**
 * Arm slot: stub.
 *
 * Trivial constant predictor (always grade 2, "Relevant"). Exists ONLY to
 * smoke-test the harness end to end (extraction -> mapping -> metrics ->
 * results JSON) before real arms (A: BM25, B: Ollama llama3.2:3b, C: bge
 * fine-tune, D: mlx LoRA) are built in later handoffs. Its scores are
 * expected to be poor -- that is not a bug.
 */
export const ARM_NAME = "stub";

/**
 * predict(pairs): pairs = [{ query, title }], returns [{ pred_grade, latency_ms, cold }]
 * in the same order. Timed per-pair so the harness can report warm/cold
 * latency without the arm needing to know about speedStats internals.
 */
export function predict(pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    const start = process.hrtime.bigint();
    const pred_grade = 2; // constant
    const end = process.hrtime.bigint();
    const latency_ms = Number(end - start) / 1e6;
    out.push({ pred_grade, latency_ms, cold: i === 0 });
  }
  return out;
}
