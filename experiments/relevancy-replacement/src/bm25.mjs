/**
 * Okapi BM25 corpus index + scoring (Arm A, handoff 01).
 *
 * Corpus = the DISTINCT product titles appearing in ESCI-train (not one row
 * per (query,title) pair -- a title can be matched by many queries, and
 * counting it once per query would inflate its document frequency and skew
 * IDF for popular products). Documented per the handoff's "document the
 * tokenizer / method" requirement.
 *
 * Standard Okapi BM25:
 *   score(q,d) = sum over unique query terms t:
 *     idf(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1*(1 - b + b*|d|/avgdl))
 *   idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))   (non-negative variant)
 * A query term never seen in the corpus (df=0) uses the df=0 case of the same
 * formula (a high, but not infinite, IDF) rather than being skipped -- it
 * still only contributes to the score if the specific title being scored
 * actually contains it (tf>0), so an OOV term with tf=0 contributes 0 either way.
 */
import { tokenize } from "./tokenize.mjs";

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** Build a frozen BM25 index from an array of title strings (may contain duplicates; deduped here). */
export function buildCorpusIndex(titles, { k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
  const uniqueTitles = [...new Set(titles)];
  const df = new Map(); // term -> number of distinct documents containing it
  let totalLength = 0;

  for (const title of uniqueTitles) {
    const tokens = tokenize(title);
    totalLength += tokens.length;
    const seen = new Set(tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const N = uniqueTitles.length;
  const avgdl = N > 0 ? totalLength / N : 0;
  const idf = {};
  for (const [term, docFreq] of df) {
    idf[term] = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
  }
  // IDF for a term never seen in the corpus (df=0), computed once and reused.
  const idfUnseen = Math.log(1 + (N + 0.5) / 0.5);

  return { idf, idfUnseen, avgdl, N, k1, b, tokenizer: "lowercased alphanumeric runs, no stemming/stopwords" };
}

function termIdf(index, term) {
  return Object.prototype.hasOwnProperty.call(index.idf, term) ? index.idf[term] : index.idfUnseen;
}

/** BM25 score of `title` against `query`, using a frozen index (idf/avgdl/N/k1/b). */
export function scoreBm25(query, title, index) {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return 0;

  const docTokens = tokenize(title);
  const docLen = docTokens.length;
  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const { k1, b, avgdl } = index;
  let score = 0;
  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue; // no contribution regardless of idf
    const idf = termIdf(index, term);
    const denom = f + k1 * (1 - b + (b * docLen) / (avgdl || 1));
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return score;
}

/** Plain-object index -> JSON-serializable form (idf is already a plain object). */
export function serializeIndex(index) {
  return index;
}
