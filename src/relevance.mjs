/**
 * LLM relevance judging, and NDCG over the resulting judgments.
 *
 * Division of labour, from Generation 0's survey:
 *   - Cortex produces GRADED JUDGMENTS. That is the part that needs a model, and the part
 *     that carries the real risk (BDD-020: a confident wrong grade is invisible).
 *   - retail-search computes the RANKING METRIC. Already correct, already tested, reused
 *     verbatim (src/vendor/retail-search-metrics.mjs).
 *
 * The grading scale is 0-3 graded relevance paired with retail-search's default `graded` gain
 * (2^g - 1), which is the conventional pairing. Nothing in ecommmerce-eval currently
 * constrains the scale, so this is a proposed default rather than a discovered requirement.
 *
 * Honest limitation, carried from Generation 0: `ecommmerce-eval` captures only 8 candidates
 * per query and discards product hrefs, so real NDCG@10 over its evidence is not yet
 * computable. Fixing that is a change to that repo, which Cortex must not make (MISSION.md:48).
 * `ndcgForJudgments` therefore reports the k it actually used rather than silently padding an
 * 8-item list to 10 -- an NDCG@10 computed over 8 candidates would be a quietly wrong number,
 * which is exactly the risk MISSION.md:93 names.
 */
import { createHash } from "node:crypto";
import { ndcgAtK, precisionAtK, averagePrecision, reciprocalRank } from "./vendor/retail-search-metrics.mjs";

export const RELEVANCE_SCALE = {
  0: "Irrelevant - does not match the search intent at all",
  1: "Marginal - same broad category but does not satisfy the intent",
  2: "Relevant - satisfies the intent but is not an ideal match",
  3: "Perfect - exactly what the searcher intended",
};

/**
 * Judge system prompt.
 *
 * A cautionary note is recorded here because the history of this prompt is itself the best
 * argument for the service.
 *
 * The first judge run failed 3/3: the model replied "I would rate the product's relevance as
 * 9/10" in prose, on a 0-10 scale nobody asked for. The natural reading was "the small model
 * ignored the format instruction", and the natural fix was to rewrite the prompt.
 *
 * That reading was wrong. The real cause was a Cortex wiring bug -- `buildRelevanceJob` emits
 * `system_prompt` while `queue.submitJob` read `systemPrompt`, so the system prompt was
 * silently dropped and the model was called with NO instructions whatsoever. It was not
 * ignoring the contract; it had never been shown one. Answering in prose on a familiar scale
 * was the only sensible thing it could have done.
 *
 * Fixed in queue.mjs (`normalizeCallInput`, which now throws rather than dropping fields).
 *
 * The lesson generalises, and it is exactly MISSION.md:11's point read in reverse: "blame the
 * prompt, not the model" is only safe when the trace can prove the model actually received
 * the prompt. Without that proof, "blame the prompt" becomes a way to blame the prompt for
 * infrastructure bugs -- which is why BDD-018 and the `diagnosis` block in trace.mjs exist,
 * and why traces record what the model actually consumed rather than what Cortex meant to
 * send.
 *
 * The structure below (contract first and last, scale pinned, competing conventions ruled
 * out, worked examples) was retained afterwards on its own merits: it is genuinely better for
 * a 3B model. But it was not what fixed the bug, and pretending otherwise would be the same
 * misattribution in a comment.
 */
/**
 * The judge system prompt is COMPOSED, not fixed: Cortex owns the structural FRAME (output
 * format + the 0-3 scale + parse contract) and the caller may supply the domain RUBRIC (what
 * counts as relevant for THEIR catalogue).
 *
 * Why the split. The rubric is domain knowledge -- e.g. "#8 means No. 8 gauge" is a fact about
 * an ecommerce hardware catalogue, not about LLM execution. Baking every such rule into Cortex
 * couples Cortex's release cycle to one client's prompt tuning and cannot serve a second client
 * with a different catalogue. So the rubric is a caller input. But the FRAME is NOT overridable:
 * the 0-3 scale and one-line-JSON contract are the invariants that make a Cortex grade
 * trustworthy and parseable (`parseJudgment` enforces them). A caller who could replace the
 * whole prompt could ship a 0-10 scale (mass parse failures) or silently redefine what a grade
 * means while the store still looks uniform. Traceability is unaffected: the FULL composed
 * system_prompt is captured in every trace as before, and `rubricHash` gives a stable version
 * id so grades can be grouped by the exact instructions that produced them.
 *
 * The DEFAULT_JUDGE_RUBRIC below is the ecommmerce-eval rubric (MEASUREMENT NOTATION + PRODUCT
 * TYPE), used when a caller supplies none, so existing behaviour is unchanged. Its history is
 * the best argument for the service: an earlier run failed 3/3 with the model answering "9/10"
 * in prose, which read as "the model ignored the format" -- but the real cause was a Cortex
 * wiring bug dropping system_prompt entirely (`systemPrompt` vs `system_prompt`). The model had
 * never been shown the contract. That is MISSION.md:11 in reverse: "blame the prompt, not the
 * model" is only safe once the trace proves the model received the prompt (BDD-018).
 */
const JUDGE_FRAME_HEAD = [
  "You are a search relevance judge for an ecommerce catalogue.",
  "",
  "OUTPUT FORMAT - this is the most important rule:",
  'Reply with ONE line of raw JSON and nothing else: {"grade": <integer>, "reason": "<short sentence>"}',
  "No prose. No explanation before or after. No markdown fences. No <think> blocks.",
  "",
  "GRADE SCALE - use these integers only:",
  // Generated from RELEVANCE_SCALE so the 0-3 contract has one source of truth.
  ...Object.entries(RELEVANCE_SCALE).map(([g, d]) => `  ${g} = ${d}`),
  "",
  "Do NOT use a 0-10, 1-5, or percentage scale. The only valid grades are 0, 1, 2, and 3.",
].join("\n");

const JUDGE_FRAME_TAIL = 'Reply with only the JSON object: {"grade": <0-3>, "reason": "<short sentence>"}';

export const DEFAULT_JUDGE_RUBRIC = [
  "MEASUREMENT NOTATION - cosmetic, never lowers a grade:",
  "The query and product may write the SAME measurement differently. These are IDENTICAL and must NOT reduce the grade:",
  '  - spacing/hyphens: "1/2 in" = "1/2in" = "1/2-in"',
  `  - quotes/words: '1/2"' = "1/2 inch" = "half inch"`,
  '  - fractions/decimals: "1/2 in" = "0.5 in" = ".5 inch"',
  '  - metric spacing: "10 mm" = "10mm" = "10-mm"',
  '  - wire gauge synonyms: "12 gauge" = "12ga" = "12 AWG" = "12-gauge"',
  `  - number/gauge prefixes: "#8" = "no 8" = "no. 8" = "number 8" — the #, no, no., and number prefixes are the SAME gauge. "#8 ... Wood Screw" fully satisfies a "no 8 wood screw" query. Never require the words "no"/"number" to appear in the product title, and never read "no" as negation.`,
  `Judge on the product's ACTUAL size, not on how the query is punctuated. Never write a reason like "incorrect size unit" or "wrong notation".`,
  "",
  "PRODUCT TYPE - this DOES matter:",
  "Match the head noun of the query. If the query asks for one item but the product is a related-but-different type, it is NOT a perfect match:",
  '  - a fitting, elbow, coupling, tee, cap, adapter, or valve is NOT the same as a length of "pipe" -> grade 2 (or 1)',
  "  - an accessory (tie wire, bit, blade, filter) is NOT the tool/material itself -> grade 1",
  '  - a multi-tool "set" or "kit" when a single item was searched -> grade 2',
  "Reserve grade 3 for products whose type AND size both match the query.",
  "",
  "EXAMPLE",
  "Search query: mens waterproof hiking boots",
  "Product title: Salomon Quest 4 GTX Men's Waterproof Hiking Boot",
  'Correct reply: {"grade": 3, "reason": "Exact match: mens waterproof hiking boot."}',
  "",
  "EXAMPLE (notation equivalent - do not penalize)",
  "Search query: 1/2-in screw",
  "Product title: #8 x 1/2 in. Zinc Phillips Flat Head Wood Screw",
  'Correct reply: {"grade": 3, "reason": "Half-inch screw; 1/2-in equals 1/2 in."}',
  "",
  "EXAMPLE (right size, wrong type - not perfect)",
  "Search query: 3/4 in pvc pipe",
  "Product title: 3/4 in. PVC Schedule 40 90 degree Elbow Fitting",
  'Correct reply: {"grade": 2, "reason": "Correct 3/4 in PVC size but a fitting, not a length of pipe."}',
  "",
  "EXAMPLE (No. gauge notation - do not penalize)",
  "Search query: no 8 wood screw",
  "Product title: #8 x 2-1/2 in. Phillips Bugle Head Coarse Thread Wood Screws",
  'Correct reply: {"grade": 3, "reason": "#8 is the No. 8 gauge; matches no 8 wood screw."}',
].join("\n");

/**
 * Compose the full judge system prompt: Cortex frame + (caller rubric | default) + frame tail.
 * The frame always wraps the rubric so the scale/format contract cannot be dropped.
 */
export function buildJudgeSystemPrompt(rubric = null) {
  const body = typeof rubric === "string" && rubric.trim() ? rubric.trim() : DEFAULT_JUDGE_RUBRIC;
  return [JUDGE_FRAME_HEAD, "", body, "", JUDGE_FRAME_TAIL].join("\n");
}

/** Stable short id for a composed system prompt, so grades can be grouped by exact instructions. */
export function rubricHash(systemPrompt) {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12);
}

// Back-compat: the default composed prompt. Equal to buildJudgeSystemPrompt() with no rubric.
export const JUDGE_SYSTEM_PROMPT = buildJudgeSystemPrompt();

export function buildJudgePrompt({ query, product }) {
  return [
    `Search query: ${query}`,
    `Product title: ${product.title}`,
    ...(product.description ? [`Product description: ${product.description}`] : []),
    "",
    "Grade this product's relevance to the query.",
  ].join("\n");
}

/**
 * Parse a judge response.
 *
 * Strips <think> blocks (qwen3 emits them) and markdown fences, then requires an integer grade
 * within the declared scale. A response that does not parse is an error rather than a default
 * grade: silently coercing an unparseable answer to 0 would feed a fabricated judgment into
 * NDCG and produce a plausible, wrong, untraceable number.
 */
export function parseJudgment(text) {
  if (!text || typeof text !== "string") throw new Error("judge returned no text");
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`judge response contained no JSON object: ${text.slice(0, 120)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`judge response was not valid JSON: ${err.message}`);
  }
  const grade = Number(parsed.grade);
  if (!Number.isInteger(grade) || !(grade in RELEVANCE_SCALE)) {
    throw new Error(`judge returned grade ${JSON.stringify(parsed.grade)}, outside the 0-3 scale`);
  }
  return { grade, reason: typeof parsed.reason === "string" ? parsed.reason : null };
}

/**
 * Build the per-call payloads for a relevance job.
 * One call per (query, product) pair: the unit of execution is the unit of traceability
 * (MISSION.md:23), so every individual grade gets its own trace ID and can be audited.
 */
export function buildRelevanceJob({ queries, params = {}, minContextWindow, rubric = null }) {
  // Compose once: every judgment in the job is graded under the same instructions, and the
  // composed prompt (frame + rubric) is what gets captured in each trace.
  const systemPrompt = buildJudgeSystemPrompt(rubric);
  const calls = [];
  for (const q of queries) {
    for (const product of q.products) {
      calls.push({
        prompt: buildJudgePrompt({ query: q.query, product }),
        system_prompt: systemPrompt,
        params: { temperature: 0, maxTokens: 120, ...params },
        min_context_window: minContextWindow,
        purpose: "relevance_judgment",
        _meta: { query_id: q.query_id, product_id: product.id },
      });
    }
  }
  return calls;
}

/**
 * Compute NDCG from judgments.
 *
 * `k` defaults to the real candidate count rather than 10 when fewer than 10 candidates
 * exist, and the return value always states the k used and the candidate count, so a caller
 * can never mistake an @8 number for an @10 number.
 */
export function ndcgForJudgments({ ranking, judgments, k = null, relevanceMode = "graded" }) {
  const qrels = {};
  for (const j of judgments) qrels[j.product_id] = j.grade;
  // A requested k is capped at the number of candidates actually present: nDCG@10 over 8
  // items is nDCG@8, and reporting it as @10 would overstate the evaluation depth (the exact
  // ecommmerce-eval gap from Generation 0, where only 8 candidates are captured per query).
  const truncatedFromRequested = k != null && ranking.length < k;
  const effectiveK = k != null ? Math.min(k, ranking.length) : Math.max(1, Math.min(10, ranking.length));

  /**
   * Refuse to score an incompletely-judged ranking.
   *
   * Without this, a ranking whose judgments all failed to parse scores nDCG=0 -- which reads
   * as "the search ranked terribly" when the truth is "we have no data". That is precisely
   * the plausible-but-wrong number MISSION.md:93 names as a risk, and it is worse than an
   * error because it is silent and looks like a legitimate result.
   *
   * Found by running the judge against the real local model: llama3.2:3b ignored the JSON
   * contract, every judgment failed to parse, and this function happily returned 0.
   */
  const judged = new Set(judgments.map((j) => j.product_id));
  const consideredIds = ranking
    .slice(0, effectiveK)
    .map((r) => (typeof r === "string" ? r : r.id));
  const unjudged = consideredIds.filter((id) => !judged.has(id));
  if (unjudged.length > 0) {
    return {
      ndcg: null,
      k: effectiveK,
      candidates: ranking.length,
      relevance_mode: relevanceMode,
      error: "incomplete_judgments",
      unjudged_ids: unjudged,
      message:
        `Refusing to compute nDCG: ${unjudged.length} of ${consideredIds.length} ranked ` +
        `items within k=${effectiveK} have no judgment (${unjudged.slice(0, 5).join(", ")}). ` +
        `Scoring them as irrelevant would report a confident number derived from missing ` +
        `data. Resolve the failed judgments and retry.`,
    };
  }

  return {
    ndcg: ndcgAtK(ranking, qrels, effectiveK, { relevanceMode }),
    precision: precisionAtK(ranking, qrels, effectiveK),
    average_precision: averagePrecision(ranking, qrels, effectiveK),
    reciprocal_rank: reciprocalRank(ranking, qrels, effectiveK),
    k: effectiveK,
    candidates: ranking.length,
    relevance_mode: relevanceMode,
    ...(truncatedFromRequested
      ? {
          warning:
            `Requested nDCG@${k} but only ${ranking.length} candidates were supplied, so this ` +
            `is nDCG@${effectiveK}. Reporting it as @${k} would overstate the evaluation depth.`,
        }
      : {}),
  };
}
