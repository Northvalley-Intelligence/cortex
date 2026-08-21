/**
 * Durable priority queue.
 *
 * Two mission rules shape this file:
 *
 *   1. Calls beat job-calls (MISSION.md:23). A live command must not wait behind a batch.
 *   2. Job-calls must never starve (MISSION.md:62,87). "Calls always win" would satisfy rule 1
 *      and violate rule 2, so a fairness floor forces a job-call through every Nth dispatch.
 *
 * Leases are the durability mechanism. A dispatched call is marked `executing` *in the
 * database* with an expiry. If the machine sleeps or the process dies, nothing needs to
 * notice or clean up: the lease simply expires and the call becomes dispatchable again
 * (BDD-004). There is no in-memory execution state to lose.
 */
import { randomUUID } from "node:crypto";

/**
 * Normalize a call descriptor into the canonical internal shape.
 *
 * This exists because of a real bug, not a hypothetical one. Callers cross this boundary in
 * two spellings: the HTTP API speaks snake_case (`system_prompt`), while the internal queue
 * speaks camelCase (`systemPrompt`). `submitJob` read only `c.systemPrompt`, so a job built
 * in API shape silently dropped its system prompt -- the model was called with no
 * instructions at all and answered in a free-form style.
 *
 * What makes that bug worth this much defence is how it presented: it looked exactly like a
 * bad prompt. The obvious reading of the trace was "the model ignored the format", and the
 * obvious fix was to rewrite the prompt -- which would have been wasted work against a
 * harness fault. That is the failure BDD-018 exists to prevent, and it is the reason
 * `missing` throws below rather than defaulting: a silently absent prompt must never reach a
 * model.
 */
export function normalizeCallInput(c) {
  const prompt = c.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("call.prompt is required and must be a non-empty string");
  }
  const known = new Set([
    "prompt", "systemPrompt", "system_prompt", "params", "minContextWindow",
    "min_context_window", "purpose", "priorityClass", "priority_class", "client", "_meta",
  ]);
  const unknown = Object.keys(c).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    // Fail loudly rather than ignore: an unrecognised key is usually a misspelling of a real
    // one, and silently dropping it is how the system_prompt bug happened in the first place.
    throw new Error(
      `unrecognised call field(s): ${unknown.join(", ")}. ` +
        `Did you mean one of: prompt, system_prompt, params, min_context_window, purpose?`,
    );
  }
  return {
    prompt,
    systemPrompt: c.systemPrompt ?? c.system_prompt ?? null,
    params: c.params ?? {},
    minContextWindow: c.minContextWindow ?? c.min_context_window,
    purpose: c.purpose,
    priorityClass: c.priorityClass ?? c.priority_class,
  };
}

export class Queue {
  #db;
  #config;
  /** Dispatch counter driving the fairness floor. Advisory only -- never a correctness input. */
  #dispatchCount = 0;

  constructor(db, config) {
    this.#db = db;
    this.#config = config;
  }

  submitCall({ client, purpose, prompt, systemPrompt, params = {}, minContextWindow, jobId = null, priorityClass = "call" }) {
    const id = jobId ? `call_${randomUUID()}` : `call_${randomUUID()}`;
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO calls (id, job_id, client, purpose, priority_class, status, prompt,
           system_prompt, params, min_context_window, submitted_at, attempts)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        jobId,
        client,
        purpose ?? null,
        priorityClass,
        prompt,
        systemPrompt ?? null,
        JSON.stringify(params),
        minContextWindow ?? this.#config.defaultMinContextWindow,
        now,
      );
    return id;
  }

  submitJob({ client, purpose, calls, metadata = {} }) {
    const jobId = `job_${randomUUID()}`;
    const now = Date.now();
    // One transaction: a job that half-exists after a crash would violate "nothing is lost".
    const tx = this.#db.prepare("BEGIN");
    tx.run();
    try {
      this.#db
        .prepare(`INSERT INTO jobs (id, client, purpose, submitted_at, metadata) VALUES (?, ?, ?, ?, ?)`)
        .run(jobId, client, purpose ?? null, now, JSON.stringify(metadata));
      const callIds = calls.map((raw) => {
        const c = normalizeCallInput(raw);
        return this.submitCall({
          client,
          purpose: c.purpose ?? purpose,
          prompt: c.prompt,
          systemPrompt: c.systemPrompt,
          params: c.params,
          minContextWindow: c.minContextWindow,
          jobId,
          priorityClass: "job",
        });
      });
      this.#db.prepare("COMMIT").run();
      return { jobId, callIds };
    } catch (err) {
      this.#db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  /**
   * Return expired leases to the queue.
   *
   * This is the machine-sleep recovery path. It runs on every dispatch and at startup, so a
   * call stranded by a dead process is recovered without any explicit crash handling.
   */
  reclaimExpiredLeases(now = Date.now()) {
    const result = this.#db
      .prepare(
        `UPDATE calls SET status = 'queued', lease_expires_at = NULL
         WHERE status = 'executing' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(now);
    return result.changes;
  }

  /**
   * Lease the next call to execute, or null if the queue is empty.
   *
   * Priority: calls first, then job-calls, each FIFO by submission time -- except every Nth
   * dispatch, which is reserved for a job-call if one is waiting. That reservation is the
   * fairness floor: without it, a steady drip of live calls would hold a batch at zero
   * progress indefinitely.
   */
  lease(now = Date.now(), canRun = null) {
    this.reclaimExpiredLeases(now);

    const fairnessTurn =
      this.#config.fairnessEveryNDispatches > 0 &&
      (this.#dispatchCount + 1) % this.#config.fairnessEveryNDispatches === 0;

    // canRun lets the worker skip a call whose primary provider is at its concurrency limit
    // WITHOUT losing priority order: within each class we still take the oldest RUNNABLE call,
    // so a saturated-provider call is passed over rather than leased-then-requeued (which would
    // churn and risk priority inversion). When canRun is absent, this is the old behaviour.
    const order = fairnessTurn ? ["job", "call"] : ["call", "job"];
    let row = null;
    for (const cls of order) {
      row = this.#firstRunnable(cls, canRun);
      if (row) break;
    }
    if (!row) return null;

    const leaseExpiry = now + this.#config.leaseMs;
    const claimed = this.#db
      .prepare(
        `UPDATE calls SET status = 'executing', started_at = COALESCE(started_at, ?),
           lease_expires_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, leaseExpiry, row.id);

    // Lost a race with another worker; the caller simply retries.
    if (claimed.changes === 0) return null;

    this.#dispatchCount += 1;
    return this.getCall(row.id);
  }

  /**
   * The oldest queued call of a class that `canRun` accepts (or simply the oldest if no
   * predicate). Only the lightweight fields the predicate needs are loaded, so scanning past a
   * few saturated-provider calls is cheap.
   */
  #firstRunnable(priorityClass, canRun) {
    const rows = this.#db
      .prepare(
        `SELECT id, min_context_window, priority_class FROM calls
         WHERE status = 'queued' AND priority_class = ?
         ORDER BY submitted_at ASC, rowid ASC`,
      )
      .all(priorityClass);
    for (const r of rows) {
      if (!canRun || canRun(r)) return r;
    }
    return null;
  }

  getCall(id) {
    const row = this.#db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id);
    if (!row) return null;
    return { ...row, params: JSON.parse(row.params || "{}") };
  }

  complete(id, { status, output, errorCode, errorMessage, providerId, model }) {
    this.#db
      .prepare(
        `UPDATE calls SET status = ?, output = ?, error_code = ?, error_message = ?,
           provider_id = ?, model = ?, completed_at = ?, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(
        status,
        output ?? null,
        errorCode ?? null,
        errorMessage ?? null,
        providerId ?? null,
        model ?? null,
        Date.now(),
        id,
      );
  }

  /** Hand a call back to the queue without consuming an attempt-slot decision. */
  requeue(id) {
    this.#db
      .prepare(`UPDATE calls SET status = 'queued', lease_expires_at = NULL WHERE id = ?`)
      .run(id);
  }

  /**
   * Job status.
   *
   * A job completes automatically when every constituent call is terminal (MISSION.md:23).
   * Partial outcomes are reported as counts rather than collapsed into a single verdict: a
   * batch where 9 of 10 calls succeeded is not "failed", and callers need to see that
   * (BDD-002).
   */
  getJob(jobId) {
    const job = this.#db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    if (!job) return null;
    const calls = this.#db
      .prepare(`SELECT id, status FROM calls WHERE job_id = ? ORDER BY rowid ASC`)
      .all(jobId);
    const counts = calls.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
    const terminal = calls.every((c) => ["succeeded", "failed", "exhausted"].includes(c.status));
    return {
      job_id: jobId,
      client: job.client,
      purpose: job.purpose,
      submitted_at: job.submitted_at,
      status: terminal ? "complete" : "in_progress",
      call_ids: calls.map((c) => c.id),
      counts: {
        total: calls.length,
        queued: counts.queued ?? 0,
        executing: counts.executing ?? 0,
        succeeded: counts.succeeded ?? 0,
        failed: counts.failed ?? 0,
        exhausted: counts.exhausted ?? 0,
      },
      metadata: JSON.parse(job.metadata || "{}"),
    };
  }

  /**
   * List jobs newest-first, straight from the jobs table — deliberately NOT derived from the
   * recent-traces feed. A jobs view built by grouping the most recent N calls gets crowded out
   * the moment live traffic (or one large job) fills that window, which is exactly how a
   * submitted eval batch became invisible. Reading the jobs table directly, with limit/offset,
   * means jobs are always listable and pageable regardless of call volume.
   */
  listJobs({ limit = 25, offset = 0, client = null } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 25));
    const off = Math.max(0, Number(offset) || 0);
    const filter = client ? "WHERE j.client = ?" : "";
    const rows = this.#db
      .prepare(
        `SELECT j.id, j.client, j.purpose, j.submitted_at, j.metadata,
           (SELECT COUNT(*) FROM calls c WHERE c.job_id = j.id) AS total,
           (SELECT COUNT(*) FROM calls c WHERE c.job_id = j.id AND c.status = 'succeeded') AS succeeded,
           (SELECT COUNT(*) FROM calls c WHERE c.job_id = j.id AND c.status IN ('failed','exhausted')) AS failed,
           (SELECT COUNT(*) FROM calls c WHERE c.job_id = j.id AND c.status IN ('queued','executing')) AS pending
         FROM jobs j ${filter} ORDER BY j.submitted_at DESC, j.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...(client ? [client] : []), lim, off);
    const total = this.#db.prepare(`SELECT COUNT(*) n FROM jobs j ${filter}`).get(...(client ? [client] : [])).n ?? 0;
    return {
      total,
      limit: lim,
      offset: off,
      jobs: rows.map((j) => {
        let md = {};
        try { md = JSON.parse(j.metadata || "{}"); } catch { md = {}; }
        // A fully-cached relevance job has 0 fresh calls but real cached judgments; surface both
        // so it never looks empty.
        const cachedCount = md.cache?.hits ?? 0;
        return {
          job_id: j.id,
          client: j.client,
          purpose: j.purpose,
          submitted_at: j.submitted_at,
          status: (j.pending ?? 0) > 0 ? "in_progress" : "complete",
          counts: {
            total: j.total ?? 0,
            succeeded: j.succeeded ?? 0,
            failed: j.failed ?? 0,
            pending: j.pending ?? 0,
            served_from_cache: cachedCount,
          },
          rubric_hash: md.rubric_hash ?? null,
          cache: md.cache ?? null,
        };
      }),
    };
  }

  depth() {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='queued' AND priority_class='call' THEN 1 ELSE 0 END) AS queued_calls,
           SUM(CASE WHEN status='queued' AND priority_class='job'  THEN 1 ELSE 0 END) AS queued_job_calls,
           SUM(CASE WHEN status='executing' THEN 1 ELSE 0 END) AS executing
         FROM calls`,
      )
      .get();
    return {
      queued_calls: row.queued_calls ?? 0,
      queued_job_calls: row.queued_job_calls ?? 0,
      executing: row.executing ?? 0,
    };
  }
}
