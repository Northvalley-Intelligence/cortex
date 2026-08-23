/**
 * Shared prompt template for Arm D (Llama-3.2-3B LoRA, handoff 04). Single
 * source for both the LoRA training-data prep (scripts/prepare_mlx_lora_data.mjs,
 * this Node module) and Python inference (scripts/mlx_infer.py, which cannot
 * `import` a .mjs) -- the data-prep script writes the rendered template to
 * data/mlx_lora_data/prompt_template.txt with `__QUERY__`/`__TITLE__`
 * placeholders, and mlx_infer.py does a plain string .replace() on that same
 * file at eval time. This guarantees train-time and inference-time prompts
 * are byte-identical without duplicating the RELEVANCE_SCALE text in Python.
 *
 * The scale wording is IMPORTED from Cortex's own RELEVANCE_SCALE
 * (src/relevance.mjs), never re-typed, per journal 00's contract. Unlike Arm
 * B (ollama_prompt.mjs), this does NOT reuse Cortex's buildJudgePrompt/
 * buildJudgeSystemPrompt -- those instruct the model to emit a JSON object
 * with a "reason" field for free-generation. Arm D instead asks for a bare
 * single digit, because inference reads the NEXT-TOKEN LOGITS at the position
 * right after "Grade:" -- it never generates or parses text. The four grade
 * digits ("0".."3") are single tokens with no leading space for the
 * mlx-community/Llama-3.2-3B-Instruct-4bit tokenizer (verified: encode("0")
 * -> [15], "1"->[16], "2"->[17], "3"->[18]; a leading space would split into
 * two tokens), and the chat template's assistant turn ends in "...\n\n" with
 * no trailing space, so the label token is the very next token after the
 * prompt with no offset ambiguity.
 */
import { RELEVANCE_SCALE } from "../../../src/relevance.mjs";

export const LABEL_TOKENS = Object.keys(RELEVANCE_SCALE)
  .map(Number)
  .sort((a, b) => a - b)
  .map(String);

function scaleDescription() {
  return Object.entries(RELEVANCE_SCALE)
    .map(([grade, desc]) => `${grade} = ${desc}`)
    .join("\n");
}

/** The header + placeholders, exactly what's persisted to prompt_template.txt. */
export function promptTemplate() {
  return (
    `Grade how well the product matches the search query. Output ONLY a single digit: ${LABEL_TOKENS.join(", ")}.\n\n` +
    `${scaleDescription()}\n\n` +
    `Search query: __QUERY__\n` +
    `Product title: __TITLE__\n\n` +
    `Grade:`
  );
}

/** Render the template for one (query, title) pair -- used by the data-prep script. */
export function buildPrompt(query, title) {
  return promptTemplate().replace("__QUERY__", query).replace("__TITLE__", title);
}
