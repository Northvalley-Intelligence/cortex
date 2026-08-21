/**
 * Judgment cache for relevance evaluation.
 *
 * Relevance judgments are the one workload where caching is not an approximation but the SAME
 * answer: they run at temperature 0, so a repeated (prompt, system prompt, params, model)
 * request is deterministic. The pain it removes is real -- a local judgment is a 60s+ call, and
 * an eval batch re-run (e.g. after eval-reports fixes candidate capture) re-judges mostly
 * identical (query, product) pairs while only the RANKING changed. Judgments are independent of
 * rank position, so almost every pair is a hit on a re-run.
 *
 * The cache key is the exact content that determines the output -- the composed system prompt
 * (which folds in the rubric via rubric_hash), the per-pair prompt (which folds in the query
 * and the product's title/description), the effective params, and a model-scope token. This is
 * the load-bearing decision: MISSION.md:93 names a confident-but-wrong number as the top risk,
 * and a cache keyed on too little (say, just query+product) would serve a pre-rubric-change
 * grade after the rubric was tuned -- exactly that failure. Change the rubric, the prompt, the
 * params, or the configured judge model, and the key changes and the cache correctly misses.
 *
 * Provenance is preserved: a served grade records the trace it came from and the model that
 * produced it, so it stays auditable in the viewer rather than becoming an anonymous number.
 */
import { createHash } from "node:crypto";

/**
 * A token identifying the configured judge model chain. Included in every key so that swapping
 * the judge model (or reordering the chain) invalidates the cache automatically -- a grade from
 * a different model is a different answer. NOTE: this keys on the configured model *names*, not
 * a weights digest, so a silent re-pull of the same tag is not detected; clear the cache
 * (POST /v1/admin/prune {cache:true}) after deliberately updating a model in place.
 */
export function judgeModelScope(config) {
  return (config.providers ?? []).map((p) => `${p.id}:${p.model}`).join("|");
}

/** Stable stringify: sort object keys so param order can't change the key. */
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}

/**
 * Cache key for one judgment, hashed from exactly what the executor will send to the model.
 * Keying on the real prompt + system prompt (not re-derived fields) means the key cannot drift
 * from the request.
 */
export function computeJudgmentKey({ prompt, systemPrompt, params, modelScope }) {
  const canonical = stable([prompt, systemPrompt ?? "", params ?? {}, modelScope ?? ""]);
  return createHash("sha256").update(canonical).digest("hex");
}

const SELECT = `SELECT grade, reason, source_trace_id, model, created_at FROM judgment_cache WHERE cache_key = ?`;

/** Look up a cached judgment; records a hit (for observability) when found. */
export function lookupJudgment(db, key) {
  const row = db.prepare(SELECT).get(key);
  if (!row) return null;
  db.prepare(`UPDATE judgment_cache SET hits = hits + 1 WHERE cache_key = ?`).run(key);
  return row;
}

/**
 * Persist a fresh judgment. INSERT OR IGNORE: a repeated poll of the same completed job must
 * not clobber an existing entry (or its hit counter). Only successful, parseable grades are
 * ever stored -- a failed or unparseable judgment is never cached, so a transient bad run does
 * not freeze a wrong grade.
 */
export function storeJudgment(db, { key, grade, reason, sourceTraceId, model, now }) {
  db.prepare(
    `INSERT OR IGNORE INTO judgment_cache (cache_key, grade, reason, source_trace_id, model, created_at, hits)
     VALUES (?,?,?,?,?,?,0)`,
  ).run(key, grade, reason ?? null, sourceTraceId, model ?? null, now);
}

export function judgmentCacheStats(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS total_hits, MIN(created_at) AS oldest,
              COALESCE(SUM(LENGTH(cache_key) + LENGTH(COALESCE(reason,'')) + LENGTH(source_trace_id)
                       + LENGTH(COALESCE(model,'')) + 32), 0) AS est_bytes
       FROM judgment_cache`,
    )
    .get();
  // est_bytes is a content estimate (stored strings + ~32 bytes/row for the integer columns and
  // row overhead), not the exact page footprint -- enough to answer "is the cache large?".
  return {
    entries: row.entries ?? 0,
    total_hits: row.total_hits ?? 0,
    oldest: row.oldest ?? null,
    est_bytes: row.est_bytes ?? 0,
  };
}

/** Clear the whole judgment cache (used after a deliberate model update). Returns rows removed. */
export function clearJudgmentCache(db) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM judgment_cache`).get().n ?? 0;
  db.prepare(`DELETE FROM judgment_cache`).run();
  return n;
}
