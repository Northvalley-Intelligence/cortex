/**
 * Tokenizer shared by BM25 corpus building and scoring (Arm A).
 * Lowercased alphanumeric runs -- simple, deterministic, documented per the
 * handoff's requirement to document the tokenizer. No stopword removal or
 * stemming: product titles are short and terse, and a smaller, more literal
 * baseline is the honest point of Arm A (a lexical floor, not a tuned IR system).
 */
export function tokenize(text) {
  if (!text) return [];
  const matches = String(text).toLowerCase().match(/[a-z0-9]+/g);
  return matches ?? [];
}
