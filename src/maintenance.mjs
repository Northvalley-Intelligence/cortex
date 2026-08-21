/**
 * Trace-store maintenance: report storage use, and prune old traces to reclaim space.
 *
 * The trace store grows without bound by design (durability first), so an operator needs a
 * way to reclaim disk. Pruning only ever removes TERMINAL calls (succeeded/failed/exhausted)
 * — in-flight and queued work is never deleted, so cleaning up can't drop live jobs. A prune
 * is followed by VACUUM so the disk is actually returned, not just marked free.
 *
 * Deletion is irreversible, so the API requires an explicit target (an age or all:true); there
 * is no implicit "delete everything" default, and the UI confirms before calling.
 */
import { statSync } from "node:fs";

const TERMINAL = "('succeeded','failed','exhausted')";

function dbBytes(dbPath) {
  if (!dbPath || dbPath === ":memory:") return null;
  try { return statSync(dbPath).size; } catch { return null; }
}

export function storageStats(db, dbPath) {
  const c = db.prepare(`SELECT COUNT(*) n, MIN(submitted_at) oldest, MAX(submitted_at) newest FROM calls`).get();
  const a = db.prepare(`SELECT COUNT(*) n FROM attempts`).get();
  const j = db.prepare(`SELECT COUNT(*) n FROM jobs`).get();
  const inflight = db.prepare(`SELECT COUNT(*) n FROM calls WHERE status NOT IN ${TERMINAL}`).get();
  return {
    db_bytes: dbBytes(dbPath),
    calls: c.n ?? 0,
    attempts: a.n ?? 0,
    jobs: j.n ?? 0,
    in_flight: inflight.n ?? 0,
    oldest_at: c.oldest ?? null,
    newest_at: c.newest ?? null,
  };
}

/** How many terminal calls a prune would remove — for a preview before deleting. */
export function prunablePreview(db, { olderThanMs = null, all = false, now = Date.now() }) {
  const [cond, args] = whereClause({ olderThanMs, all, now });
  return db.prepare(`SELECT COUNT(*) n FROM calls WHERE ${cond}`).get(...args).n ?? 0;
}

function whereClause({ olderThanMs, all, now }) {
  if (all) return [`status IN ${TERMINAL}`, []];
  if (olderThanMs != null) return [`status IN ${TERMINAL} AND submitted_at < ?`, [now - olderThanMs]];
  throw new Error("prune requires all:true or olderThanMs");
}

export function prune(db, { olderThanMs = null, all = false, now = Date.now(), dbPath = null }) {
  const [cond, args] = whereClause({ olderThanMs, all, now });
  const before = dbBytes(dbPath);
  const targetCalls = db.prepare(`SELECT COUNT(*) n FROM calls WHERE ${cond}`).get(...args).n ?? 0;

  db.exec("BEGIN");
  let deletedAttempts = 0, deletedCalls = 0, deletedJobs = 0;
  try {
    deletedAttempts = db.prepare(`DELETE FROM attempts WHERE call_id IN (SELECT id FROM calls WHERE ${cond})`).run(...args).changes;
    deletedCalls = db.prepare(`DELETE FROM calls WHERE ${cond}`).run(...args).changes;
    // Remove jobs that no longer have any calls (their calls were pruned).
    deletedJobs = db.prepare(`DELETE FROM jobs WHERE id NOT IN (SELECT DISTINCT job_id FROM calls WHERE job_id IS NOT NULL)`).run().changes;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // VACUUM must run outside a transaction; it returns freed pages to the OS.
  db.exec("VACUUM");

  return {
    deleted_calls: deletedCalls,
    deleted_attempts: deletedAttempts,
    deleted_jobs: deletedJobs,
    matched_calls: targetCalls,
    db_bytes_before: before,
    db_bytes_after: dbBytes(dbPath),
  };
}
