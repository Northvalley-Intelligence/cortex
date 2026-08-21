/**
 * Usage and reliability metrics.
 *
 * Every number here is computed from the attempts table -- the same rows the trace reads.
 * There is no separate counter to drift out of sync, because MISSION.md:92 names misleading
 * metrics as a real risk: a dashboard is only as valuable as the traceability behind it, and
 * a wrong number that looks authoritative causes worse decisions than no number at all.
 *
 * That property is asserted, not assumed: VS-TRACE recomputes these aggregates from raw rows
 * and requires an exact match (BDD-016).
 */

import { isQuotaExhaustion } from "./failures.mjs";
import { judgmentCacheStats } from "./cache.mjs";

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function providerMetrics(db, sinceMs = null) {
  const since = sinceMs ?? 0;
  const rows = db
    .prepare(
      `SELECT provider_id, model, status, failure_kind, error_message, latency_ms, cost_usd,
              evaluated_tokens, completion_tokens, truncation_detected, started_at
       FROM attempts WHERE started_at >= ? ORDER BY started_at ASC`,
    )
    .all(since);

  // Per-provider failure rate is an ATTEMPT-level reliability signal about that provider —
  // deliberately separate from system/net failure (a provider attempt failing that fallback
  // recovers is NOT a failure the caller saw). Every rate here is scoped to the caller's
  // `sinceMs` window, so the whole view shares one time period rather than mixing scopes.
  const byProvider = new Map();
  for (const r of rows) {
    const key = `${r.provider_id}::${r.model}`;
    if (!byProvider.has(key)) {
      byProvider.set(key, {
        provider: r.provider_id,
        model: r.model,
        attempts: 0,
        succeeded: 0,
        failed: 0,
        availability_failures: 0,
        content_failures: 0,
        harness_failures: 0,
        truncations: 0,
        quota_hits: 0,
        latencies: [],
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        // Rolling view of the most recent attempt, used to derive live quota status.
        last_attempt_at: null,
        last_attempt_was_quota: false,
        last_attempt_ok: false,
        last_quota_hit_at: null,
      });
    }
    const m = byProvider.get(key);
    m.attempts += 1;
    const quota = r.status !== "succeeded" && isQuotaExhaustion(r.error_message);
    if (r.status === "succeeded") {
      m.succeeded += 1;
      if (r.latency_ms != null) m.latencies.push(r.latency_ms);
    } else {
      m.failed += 1;
      if (r.failure_kind === "availability") m.availability_failures += 1;
      if (r.failure_kind === "content") m.content_failures += 1;
      if (r.failure_kind === "harness") m.harness_failures += 1;
      if (quota) { m.quota_hits += 1; m.last_quota_hit_at = r.started_at; }
    }
    if (r.truncation_detected) m.truncations += 1;
    m.cost_usd += r.cost_usd ?? 0;
    m.input_tokens += r.evaluated_tokens ?? 0;
    m.output_tokens += r.completion_tokens ?? 0;
    // Rows are ordered by started_at, so the last write wins as "most recent".
    m.last_attempt_at = r.started_at;
    m.last_attempt_was_quota = quota;
    m.last_attempt_ok = r.status === "succeeded";
  }

  return [...byProvider.values()]
    .map((m) => {
      const sorted = [...m.latencies].sort((a, b) => a - b);
      const { latencies, last_attempt_was_quota, last_attempt_ok, last_attempt_at, ...rest } = m;
      return {
        ...rest,
        success_rate: m.attempts ? m.succeeded / m.attempts : null,
        // Attempt-level failure rates over the selected window. Provider reliability, NOT net
        // failure — availability = "couldn't answer" (drove fallback); content = "answered
        // badly" (a quality signal). Split so the number is unambiguous.
        failure_rate: m.attempts ? (m.availability_failures + m.content_failures + m.harness_failures) / m.attempts : null,
        availability_failure_rate: m.attempts ? m.availability_failures / m.attempts : null,
        content_failure_rate: m.attempts ? m.content_failures / m.attempts : null,
        // Derived quota status: 'exhausted' if the provider's most recent attempt was a quota
        // failure (it is currently rate-limited); 'ok' otherwise. 'recovered' distinguishes a
        // provider that hit quota earlier in the window but is answering again now, so a
        // transient limit is not read as a standing outage.
        quota_status: last_attempt_was_quota ? "exhausted" : m.quota_hits > 0 ? "recovered" : "ok",
        latency_p50_ms: percentile(sorted, 50),
        latency_p90_ms: percentile(sorted, 90),
        latency_p99_ms: percentile(sorted, 99),
        cost_usd: Number(m.cost_usd.toFixed(6)),
      };
    })
    .sort((a, b) => b.attempts - a.attempts);
}

export function callMetrics(db, sinceMs = null) {
  const since = sinceMs ?? 0;
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='exhausted' THEN 1 ELSE 0 END) AS exhausted,
         SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status='executing' THEN 1 ELSE 0 END) AS executing,
         SUM(CASE WHEN priority_class='call' THEN 1 ELSE 0 END) AS live_calls,
         SUM(CASE WHEN priority_class='job' THEN 1 ELSE 0 END) AS job_calls
       FROM calls WHERE submitted_at >= ?`,
    )
    .get(since);

  const waits = db
    .prepare(
      `SELECT priority_class, (started_at - submitted_at) AS wait_ms
       FROM calls WHERE started_at IS NOT NULL AND submitted_at >= ?`,
    )
    .all(since);

  const waitFor = (cls) => {
    const sorted = waits.filter((w) => w.priority_class === cls).map((w) => w.wait_ms).sort((a, b) => a - b);
    return { p50: percentile(sorted, 50), p90: percentile(sorted, 90) };
  };

  // Fallback rate = share of calls that needed more than one provider. This is the number
  // that tells the operator the chain is doing real work rather than sitting idle.
  const fallback = db
    .prepare(
      `SELECT COUNT(*) AS n FROM calls c
       WHERE c.submitted_at >= ? AND (SELECT COUNT(*) FROM attempts a WHERE a.call_id = c.id) > 1`,
    )
    .get(since);

  const truncated = db
    .prepare(
      `SELECT COUNT(DISTINCT call_id) AS n FROM attempts WHERE truncation_detected = 1 AND started_at >= ?`,
    )
    .get(since);

  // Calls that a provider failure hit but fallback recovered: succeeded, yet took >1 attempt.
  // These are the "one provider failed but the system did not" cases — counted separately so
  // provider failures are never read as system failures.
  const recovered = db
    .prepare(
      `SELECT COUNT(*) AS n FROM calls c WHERE c.submitted_at >= ? AND c.status = 'succeeded'
         AND (SELECT COUNT(*) FROM attempts a WHERE a.call_id = c.id) > 1`,
    )
    .get(since);

  const netFailed = (row.failed ?? 0) + (row.exhausted ?? 0);

  return {
    total: row.total ?? 0,
    succeeded: row.succeeded ?? 0,
    failed: row.failed ?? 0,
    exhausted: row.exhausted ?? 0,
    // Net (system-visible) failure: calls the caller ultimately saw fail, after all fallback.
    // This is the true failure count — a recovered provider failure is NOT in here.
    net_failed: netFailed,
    net_failure_rate: row.total ? netFailed / row.total : null,
    recovered_by_fallback: recovered.n ?? 0,
    queued: row.queued ?? 0,
    executing: row.executing ?? 0,
    live_calls: row.live_calls ?? 0,
    job_calls: row.job_calls ?? 0,
    calls_needing_fallback: fallback.n ?? 0,
    fallback_rate: row.total ? (fallback.n ?? 0) / row.total : null,
    // Should always be zero. Non-zero means Cortex's own context handling is broken --
    // the one metric whose correct value is known in advance.
    truncated_calls: truncated.n ?? 0,
    queue_wait_live_ms: waitFor("call"),
    queue_wait_job_ms: waitFor("job"),
  };
}

/**
 * Job-level and judgment-cache metrics over the window.
 *
 * `jobs_in_window` answers "did work come in?" at the job grain -- an eval batch is one job of
 * many calls, and a dashboard that only counts calls makes a submitted job invisible. The cache
 * block is scoped to relevance jobs and is derived from each job's recorded cache summary, so
 * "served from cache" is a windowed number that lines up with the same period as everything
 * else, not an all-time counter (that is reported separately as `served_all_time`).
 */
export function jobMetrics(db, sinceMs = null) {
  const since = sinceMs ?? 0;
  const rows = db.prepare(`SELECT purpose, metadata FROM jobs WHERE submitted_at >= ?`).all(since);
  let servedFromCache = 0;
  let judgedFresh = 0;
  let relevanceJobs = 0;
  for (const r of rows) {
    let md = {};
    try { md = JSON.parse(r.metadata || "{}"); } catch { md = {}; }
    if (md.kind === "relevance" || r.purpose === "relevance_judgment") {
      relevanceJobs += 1;
      if (md.cache) { servedFromCache += md.cache.hits ?? 0; judgedFresh += md.cache.misses ?? 0; }
    }
  }
  const store = judgmentCacheStats(db);
  const considered = servedFromCache + judgedFresh;
  return {
    jobs_in_window: rows.length,
    relevance_jobs_in_window: relevanceJobs,
    cache: {
      // Windowed: judgments this period that a prior grade answered instead of a 60s+ model call.
      served_in_window: servedFromCache,
      judged_in_window: judgedFresh,
      hit_rate_in_window: considered ? servedFromCache / considered : null,
      // Cumulative store facts (not windowed).
      entries: store.entries,
      served_all_time: store.total_hits,
    },
  };
}

export function summary(db, sinceMs = null) {
  return {
    generated_at: Date.now(),
    window_since: sinceMs,
    calls: callMetrics(db, sinceMs),
    providers: providerMetrics(db, sinceMs),
    jobs: jobMetrics(db, sinceMs),
  };
}
