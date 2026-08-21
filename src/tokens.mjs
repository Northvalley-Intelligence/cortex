/**
 * Prompt token estimation for the pre-flight context-floor check.
 *
 * Deliberately an estimate, and deliberately a conservative one. Cortex runs a two-layer
 * defence against the silent-truncation failure:
 *
 *   Layer 1 (here): estimate before dispatch, so an obviously oversized prompt fails fast
 *                   without burning a ~1-minute model call or paid quota.
 *   Layer 2 (ollama.mjs): compare prompt_eval_count against num_ctx after dispatch. That
 *                   check is EXACT and is the authority. It catches anything this estimate
 *                   underestimates.
 *
 * Because layer 2 is the authority, this function only has to avoid *under*-estimating badly.
 * It intentionally over-estimates: rejecting a borderline-fitting prompt is a clear, visible
 * error the client can act on, whereas accepting an oversized one risks the exact silent
 * corruption the mission forbids. Erring toward "too big" is the safe direction.
 *
 * No tokenizer dependency is used: real tokenizers are model-specific, and the chain spans
 * three different families. A tokenizer would give false precision about the wrong model.
 */

/**
 * ~3.2 chars/token is conservative for English prose across GPT/Llama/Gemma-family BPE
 * tokenizers (typical is ~4). Code, JSON, and non-Latin scripts tokenize denser, and callers
 * send a lot of JSON, so the margin is intentional.
 */
const CHARS_PER_TOKEN = 3.2;

/**
 * Chat-template scaffolding cost per message.
 *
 * Measured, not guessed: a 22-char prompt ("Reply with exactly: OK") to llama3.2:3b reported
 * prompt_eval_count=30, i.e. ~23 tokens of special tokens and role headers on top of ~7
 * tokens of content. An earlier value of 8 here under-estimated that prompt by 2x, which is
 * the wrong direction for a safety check. 48 keeps short prompts conservatively over-counted
 * without meaningfully distorting long ones, where content dominates.
 */
const MESSAGE_OVERHEAD_TOKENS = 48;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimatePromptTokens({ prompt, systemPrompt }) {
  let total = estimateTokens(prompt) + MESSAGE_OVERHEAD_TOKENS;
  if (systemPrompt) total += estimateTokens(systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
  return total;
}

/**
 * Tokens that must fit inside the context window: the prompt plus the room the model needs to
 * write its answer. A window big enough for the prompt but not the completion still truncates.
 */
export function estimateRequiredWindow({ prompt, systemPrompt, params = {} }) {
  return estimatePromptTokens({ prompt, systemPrompt }) + (params.maxTokens ?? 1200);
}
