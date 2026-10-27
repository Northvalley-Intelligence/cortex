/**
 * Listwise search evaluation: grade ONE search term against its WHOLE ranked result list in a
 * single model call (per window), instead of one call per (query, product) pair.
 *
 * Division of labour, same as relevance.mjs: the MODEL produces grades and a few judgements
 * about the list; CORTEX computes everything numeric (alignment by id, coverage, head
 * completeness, the 0-100 score, the job-level findability score). A model that is wrong or
 * silent can therefore never fabricate a score: an unparseable answer, a missing item id or an
 * unknown id fails the call, and no grade is invented for it.
 */
import { RELEVANCE_SCALE, rubricHash } from "./relevance.mjs";

export const RESULT_TYPES = ["product", "guide", "recipe", "event", "collection", "page"];
export const RANKING_VALUES = ["optimal", "minor", "major", "unresolved"];
export const TASK_GUIDANCE_VALUES = ["met", "partial", "missing", "not_needed"];
export const INTENT_VALUES = ["resolved", "unresolved"];

export const DEFAULT_WINDOW = 20;
export const WINDOW_OVERLAP = 5;

/**
 * DRAFT weights for Ashik to tune. They are the only place the 0-100 arithmetic is defined.
 * Points per component; the tiers below are applied by computeScore().
 */
export const SCORE_WEIGHTS = {
  first_useful: 30, // position 1 = 30, 2-3 = 20, 4-10 = 10, later or none = 0
  coverage: 30, // coverage x 30 (unknown: 30 if any grade-3, 15 if any grade-2, else 0)
  ranking: 20, // optimal 20, minor 12, major 0; floor 20 once the head is complete
  effort: 10, // first useful <= 3: 10, <= 10: 5, else 0
  task_guidance: 10, // met 10, partial 5, missing 0; not_needed rescales the rest to 100
  first_useful_tiers: [[1, 30], [3, 20], [10, 10]],
  effort_tiers: [[3, 10], [10, 5]],
  ranking_points: { optimal: 20, minor: 12, major: 0, unresolved: 0 },
  task_guidance_points: { met: 10, partial: 5, missing: 0 },
  unknown_coverage_points: { grade3: 30, grade2: 15 },
};

/** Score thresholds for the job-level counts. */
export const SCORE_BANDS = { works: 70, failures: 40 };

/** A grade at or above this counts as a "useful" result for first_useful_position. */
export const USEFUL_GRADE = 2;

const FRAME_HEAD = [
  "You are a search relevance judge for an ecommerce site. You grade ONE search term against the",
  "WHOLE ranked list of results the site returned for it, in a single reply.",
  "",
  "GRADE SCALE - integers only:",
  ...Object.entries(RELEVANCE_SCALE).map(([g, d]) => `  ${g} = ${d}`),
  "",
  "GROUPING: results that are size/colour/quantity variants of the SAME product belong in ONE",
  "group and receive ONE grade. Every result id in the list must appear in exactly one group.",
  "",
  "OUTPUT FORMAT - reply with ONE JSON object and nothing else (no prose, no markdown fences):",
  '{"groups":[{"group_id":"g1","item_ids":["<id>","<id>"],"grade":<0-3>,"reason":"<one sentence>"}],',
  ' "first_useful_position":<integer position of the first result that satisfies the searcher, or null>,',
  ' "ranking":"optimal|minor|major|unresolved",',
  ' "ranking_reason":"<one sentence>",',
  ' "task_guidance":"met|partial|missing|not_needed",',
  ' "intent":"resolved|unresolved"}',
  "",
  "EXAMPLE (3 results a, b, c: a and b are sizes of the right product, c is unrelated - c is STILL listed):",
  '{"groups":[{"group_id":"g1","item_ids":["a","b"],"grade":3,"reason":"Right product in two sizes."},{"group_id":"g2","item_ids":["c"],"grade":0,"reason":"Unrelated to the search."}],"first_useful_position":1,"ranking":"optimal","ranking_reason":"Right product first.","task_guidance":"not_needed","intent":"resolved"}',
  "",
  "ranking: optimal = best results first; minor = small ordering problems; major = a requirement-",
  "satisfying result is buried or missing from the head; unresolved = the list cannot be judged.",
  "task_guidance: whether the list helps the searcher complete their stated task (guides, fit info).",
  "intent: unresolved only when the search term itself cannot be judged against this catalogue.",
].join("\n");

/** Compose the system prompt: Cortex frame (scale + output contract) + the caller's rubric. */
export function buildSearchEvalSystemPrompt(rubric) {
  return [
    FRAME_HEAD,
    "",
    "DOMAIN RUBRIC (from the caller):",
    String(rubric).trim(),
    "",
    "Reply with only the JSON object described in OUTPUT FORMAT.",
  ].join("\n");
}

/** JSON Schema of the model's listwise answer (Anthropic structured outputs: guarantees shape, not id completeness). */
export const SEARCH_EVAL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group_id: { type: "string" },
          item_ids: { type: "array", items: { type: "string" } },
          grade: { type: "integer", enum: [0, 1, 2, 3] },
          reason: { type: "string" },
        },
        required: ["group_id", "item_ids", "grade", "reason"],
        additionalProperties: false,
      },
    },
    first_useful_position: { type: ["integer", "null"] },
    ranking: { type: "string", enum: RANKING_VALUES },
    ranking_reason: { type: "string" },
    task_guidance: { type: "string", enum: TASK_GUIDANCE_VALUES },
    intent: { type: "string", enum: INTENT_VALUES },
  },
  required: ["groups", "first_useful_position", "ranking", "ranking_reason", "task_guidance", "intent"],
  additionalProperties: false,
};

export function searchEvalRubricHash(rubric) {
  return rubricHash(buildSearchEvalSystemPrompt(rubric));
}

/**
 * Split a list into overlapping windows of `window` items (overlap WINDOW_OVERLAP). A list that
 * fits is one window. Returns arrays of the items themselves.
 */
export function splitWindows(items, window = DEFAULT_WINDOW, overlap = WINDOW_OVERLAP) {
  if (items.length <= window) return [items];
  const step = Math.max(1, window - overlap);
  const out = [];
  for (let start = 0; start < items.length; start += step) {
    out.push(items.slice(start, start + window));
    if (start + window >= items.length) break;
  }
  return out;
}

const renderItem = (item, imageNo) => {
  const parts = [`[id=${item.id}] position ${item.position} | type: ${item.type} | title: ${item.title}`];
  if (item.description) parts.push(`  description: ${item.description}`);
  const attrs = Object.entries(item.attributes ?? {});
  if (attrs.length) parts.push(`  attributes: ${attrs.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`).join("; ")}`);
  if (item.event_date) parts.push(`  event_date: ${item.event_date}`);
  if (imageNo) parts.push(`  image: attached as image #${imageNo}`);
  return parts.join("\n");
};

/**
 * The user prompt for one window of one search. Returns { prompt, images } where images is the
 * ordered [{id,url}] list that travels in params.images (numbering matches "image #n").
 */
export function buildSearchEvalPrompt({ search, items, windowIndex, windowCount }) {
  const images = [];
  const rendered = items.map((item) => {
    if (item.image_url) images.push({ id: item.id, url: item.image_url });
    return renderItem(item, item.image_url ? images.length : null);
  });
  const lines = [
    `Search term: ${search.query}`,
    ...(search.task ? [`Searcher's task: ${search.task}`] : []),
    ...(search.interpretations?.length ? [`Accepted interpretations of the term: ${search.interpretations.join(", ")}`] : []),
    ...(search.applicable_ids?.length
      ? [`Results known to satisfy the requirement (ids): ${search.applicable_ids.join(", ")}`]
      : ["Known-correct results: not provided (judge from the rubric)."]),
    ...(windowCount > 1 ? [`This is window ${windowIndex + 1} of ${windowCount} of a longer list; positions are absolute.`] : []),
    "",
    `RESULTS (${items.length}, in ranked order):`,
    ...rendered,
    "",
    `Every one of these ${items.length} ids must appear in exactly one group, including irrelevant ones (grade 0): ${items.map((r) => r.id).join(", ")}`,
    "Grade the results now and reply with the JSON object only.",
  ];
  return { prompt: lines.join("\n"), images };
}

/**
 * Strict parse of the model's listwise answer. `ids` is the window's result ids. Throws (the
 * call is FAILED) on anything malformed, on an id the model invented, on an id in two groups
 * and on any result id left out - never fills a gap with a default grade.
 */
export function parseSearchEval(text, ids) {
  if (!text || typeof text !== "string") throw new Error("search-eval model returned no text");
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`search-eval response contained no JSON object: ${text.slice(0, 120)}`);
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`search-eval response was not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) throw new Error("search-eval response needs a non-empty groups array");

  const expected = new Set(ids);
  const seen = new Set();
  const groupIds = new Set();
  const groups = parsed.groups.map((g, i) => {
    if (!g || typeof g.group_id !== "string" || !g.group_id) throw new Error(`groups[${i}] needs a string group_id`);
    if (groupIds.has(g.group_id)) throw new Error(`duplicate group_id "${g.group_id}"`);
    groupIds.add(g.group_id);
    if (!Array.isArray(g.item_ids) || g.item_ids.length === 0) throw new Error(`group ${g.group_id} needs a non-empty item_ids array`);
    const grade = g.grade;
    if (!Number.isInteger(grade) || !(grade in RELEVANCE_SCALE)) {
      throw new Error(`group ${g.group_id} returned grade ${JSON.stringify(g.grade)}, outside the 0-3 scale`);
    }
    for (const id of g.item_ids) {
      if (!expected.has(id)) throw new Error(`group ${g.group_id} names unknown item id ${JSON.stringify(id)}`);
      if (seen.has(id)) throw new Error(`item id ${JSON.stringify(id)} appears in more than one group`);
      seen.add(id);
    }
    return { group_id: g.group_id, item_ids: [...g.item_ids], grade, reason: typeof g.reason === "string" ? g.reason : null };
  });
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`search-eval response omitted ${missing.length} result id(s): ${missing.slice(0, 5).join(", ")}; no grade is fabricated for them`);
  }

  const oneOf = (field, allowed) => {
    if (!allowed.includes(parsed[field])) throw new Error(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(parsed[field])}`);
    return parsed[field];
  };
  const fup = parsed.first_useful_position ?? null;
  if (fup !== null && !(Number.isInteger(fup) && fup >= 1)) throw new Error("first_useful_position must be a positive integer or null");
  return {
    groups,
    first_useful_position: fup,
    ranking: oneOf("ranking", RANKING_VALUES),
    ranking_reason: typeof parsed.ranking_reason === "string" ? parsed.ranking_reason : null,
    task_guidance: oneOf("task_guidance", TASK_GUIDANCE_VALUES),
    intent: oneOf("intent", INTENT_VALUES),
  };
}

/**
 * Merge per-window parses into per-item grades, ALIGNED BY ID. Windows are processed in order;
 * an item already graded by an earlier window keeps that grade, and a group that spans windows
 * is reconciled by id: its not-yet-graded members adopt the group (id, grade) of the member
 * that was graded first, so size variants never end up with different grades.
 * ranking / task_guidance / intent come from the FIRST window (the head of the list is what the
 * searcher sees); conflicts between windows' grades are counted, not hidden.
 */
export function reconcileWindows(windowParses) {
  const byId = new Map();
  let conflicts = 0;
  let groupCounter = 0;
  windowParses.forEach((parse, w) => {
    for (const g of parse.groups) {
      const known = g.item_ids.map((id) => byId.get(id)).find(Boolean);
      const gid = known ? known.group_id : `g${++groupCounter}`;
      const grade = known ? known.grade : g.grade;
      const reason = known ? known.reason : g.reason;
      for (const id of g.item_ids) {
        const prior = byId.get(id);
        if (prior) {
          if (prior.grade !== g.grade) conflicts += 1;
          continue;
        }
        byId.set(id, { group_id: gid, grade, reason, window: w });
      }
    }
  });
  const first = windowParses[0];
  return {
    byId,
    conflicts,
    ranking: first.ranking,
    ranking_reason: first.ranking_reason,
    task_guidance: first.task_guidance,
    intent: first.intent,
    model_first_useful_position: first.first_useful_position,
  };
}

const tier = (tiers, value) => {
  if (value == null) return 0;
  for (const [max, pts] of tiers) if (value <= max) return pts;
  return 0;
};

/**
 * The 0-100 findability score for one search. Pure arithmetic over Cortex-computed facts.
 * Returns null for an unresolved intent with no useful result (counted separately, never scored).
 */
export function computeScore({ items, firstUsefulPosition, coverage, headComplete, ranking, taskGuidance, intent }) {
  if (intent === "unresolved" && !items.some((i) => i.grade >= USEFUL_GRADE)) return null;
  const W = SCORE_WEIGHTS;
  const first = tier(W.first_useful_tiers, firstUsefulPosition);
  let cov;
  if (coverage != null) cov = coverage * W.coverage;
  else if (items.some((i) => i.grade === 3)) cov = W.unknown_coverage_points.grade3;
  else if (items.some((i) => i.grade === 2)) cov = W.unknown_coverage_points.grade2;
  else cov = 0;
  let rank = W.ranking_points[ranking] ?? 0;
  if (headComplete) rank = W.ranking; // tail after a complete head never costs points
  const effort = tier(W.effort_tiers, firstUsefulPosition);
  const base = first + cov + rank + effort;
  if (taskGuidance === "not_needed") {
    return Math.round((base / (W.first_useful + W.coverage + W.ranking + W.effort)) * 1000) / 10;
  }
  const total = Math.round((base + (W.task_guidance_points[taskGuidance] ?? 0)) * 10) / 10;
  // A task that needed guidance and got none is never "works".
  return taskGuidance === "missing" ? Math.min(total, SCORE_BANDS.works - 1) : total;
}

/**
 * Build one search's scorecard from its (ordered) result list and the reconciled grades.
 * `results` = [{id, position, type?, event_date?}], `asOf` = ISO date for the past-event cap, `applicable` = array|null (null/empty = unknown).
 */
export function buildScorecard({ results, applicable, reconciled, asOf }) {
  const asOfMs = asOf ? Date.parse(asOf) : NaN;
  const pastEventCapped = [];
  const itemTypes = new Map();
  const items = results.map((r) => {
    const g = reconciled.byId.get(r.id);
    itemTypes.set(r.id, r.type);
    let { grade, reason } = g;
    if (r.type === "event" && r.event_date && Number.isFinite(asOfMs)) {
      const eventMs = Date.parse(r.event_date);
      if (Number.isFinite(eventMs) && eventMs < asOfMs) {
        if (grade > 1) grade = 1;
        reason = `${reason ?? ""} [past event: ${r.event_date}]`.trim();
        pastEventCapped.push(r.id);
      }
    }
    return { id: r.id, position: r.position, grade, reason, group_id: g.group_id };
  });
  let taskGuidance = reconciled.task_guidance;
  let guidanceCoerced = false;
  if (taskGuidance === "met" || taskGuidance === "partial") {
    const contentTypes = ["guide", "recipe", "page", "event"];
    const served = items.some((i) => i.grade >= USEFUL_GRADE && contentTypes.includes(itemTypes.get(i.id)));
    if (!served) { taskGuidance = "missing"; guidanceCoerced = true; }
  }
  const useful = items.filter((i) => i.grade >= USEFUL_GRADE).map((i) => i.position);
  const firstUsefulPosition = useful.length ? Math.min(...useful) : null;

  let coverage = null;
  let headComplete = false;
  if (applicable && applicable.length > 0) {
    const pos = new Map(results.map((r) => [r.id, r.position]));
    const present = applicable.filter((id) => pos.has(id));
    coverage = present.length / applicable.length;
    headComplete = present.length === applicable.length && present.every((id) => pos.get(id) <= applicable.length);
  }
  const score = computeScore({
    items, firstUsefulPosition, coverage, headComplete,
    ranking: reconciled.ranking, taskGuidance, intent: reconciled.intent,
  });
  return {
    items,
    first_useful_position: firstUsefulPosition,
    model_first_useful_position: reconciled.model_first_useful_position,
    coverage,
    head_complete: headComplete,
    ranking: reconciled.ranking,
    ranking_reason: reconciled.ranking_reason,
    task_guidance: taskGuidance,
    ...(guidanceCoerced ? { task_guidance_coerced: true } : {}),
    intent: reconciled.intent,
    ...(reconciled.intent === "unresolved" && score !== null ? { ambiguous: true } : {}),
    ...(pastEventCapped.length ? { past_event_capped: pastEventCapped } : {}),
    window_conflicts: reconciled.conflicts,
    score_0_100: score,
  };
}

/** Job level: mean of non-null scores (1 decimal) and the works/failures/mixed/unresolved counts. */
export function summarizeScores(searchScorecards) {
  const counts = { works: 0, failures: 0, mixed: 0, unresolved: 0, failed: 0 };
  const scores = [];
  for (const s of searchScorecards) {
    if (s.status === "failed") { counts.failed += 1; continue; }
    if (s.status !== "scored") continue;
    if (s.score_0_100 === null) { counts.unresolved += 1; continue; }
    scores.push(s.score_0_100);
    if (s.score_0_100 >= SCORE_BANDS.works) counts.works += 1;
    else if (s.score_0_100 < SCORE_BANDS.failures) counts.failures += 1;
    else counts.mixed += 1;
  }
  const findability = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  return { findability_score: findability, counts };
}
