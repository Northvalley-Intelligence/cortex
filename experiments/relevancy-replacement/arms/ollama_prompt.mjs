/**
 * Arm B -- llama3.2:3b prompted via Ollama, purely local (handoff 01).
 *
 * Mirrors Cortex's own judging approach exactly, by IMPORTING Cortex's real
 * prompt-building and parsing functions rather than replicating them:
 *   - buildJudgeSystemPrompt(null) -- Cortex's frame + DEFAULT_JUDGE_RUBRIC
 *     (no caller rubric supplied, same as what Cortex-local uses by default)
 *   - buildJudgePrompt({ query, product }) -- the per-pair user prompt
 *   - parseJudgment(text) -- Cortex's own parser: throws on anything that
 *     doesn't parse to an integer within RELEVANCE_SCALE. NEVER caught and
 *     coerced to a grade here -- a parse failure is recorded as a failure by
 *     the caller (scripts/run_ollama_prompt.mjs), never silently mapped to 0.
 *   - LOCAL_MAX_CONTEXT (config.mjs) -- Cortex's num_ctx for the local
 *     provider, so this arm is not truncating the prompt differently than
 *     Cortex-local would (src/providers/ollama.mjs's whole reason to exist).
 *
 * Request shape (model, options.num_ctx, options.temperature, num_predict,
 * system, keep_alive) copied field-for-field from src/providers/ollama.mjs's
 * callOllama, so Arm B is calling Ollama exactly the way Cortex-local does --
 * the only difference is this arm talks to Ollama directly instead of via
 * Cortex's queue/cache/trace layer.
 */
import { buildJudgeSystemPrompt, buildJudgePrompt, parseJudgment } from "../../../src/relevance.mjs";
import { LOCAL_MAX_CONTEXT } from "../../../src/config.mjs";

export const ARM_NAME = "ollama_prompt";
export const MODEL = process.env.CORTEX_LOCAL_MODEL || "llama3.2:3b";
export const OLLAMA_URL = process.env.CORTEX_OLLAMA_URL || "http://localhost:11434";

const SYSTEM_PROMPT = buildJudgeSystemPrompt(null); // no caller rubric -> Cortex's DEFAULT_JUDGE_RUBRIC

/**
 * Judge a single (query, title) pair via Ollama's native /api/generate,
 * exactly as Cortex's ollama provider does.
 * Returns { pred_grade, reason, latency_ms, raw } on success, or throws on a
 * transport/HTTP error or an unparseable response (caller decides how to
 * count/report that -- never coerced to a grade here).
 */
export async function judgeOne({ query, title }) {
  const prompt = buildJudgePrompt({ query, product: { title } });
  const body = {
    model: MODEL,
    prompt,
    stream: false,
    system: SYSTEM_PROMPT,
    options: {
      num_ctx: LOCAL_MAX_CONTEXT,
      temperature: 0,
      num_predict: 120,
    },
    keep_alive: "10m",
  };

  const start = process.hrtime.bigint();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ollama ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const end = process.hrtime.bigint();
  const latency_ms = Number(end - start) / 1e6;

  // parseJudgment is Cortex's own parser (relevance.mjs): throws rather than
  // returning a default grade for anything that doesn't parse. Let it throw.
  const { grade, reason } = parseJudgment(data.response ?? "");
  return { pred_grade: grade, reason, latency_ms, raw: data.response ?? "" };
}
