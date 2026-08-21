/**
 * Durable store for the queue and the trace record.
 *
 * Durability is a mission requirement, not an optimisation: work submitted while the machine
 * is off or asleep must not be lost (MISSION.md:29,63), and the trace IS the product
 * (MISSION.md:88). Both therefore live in SQLite (node:sqlite, no dependency), not in memory.
 *
 * The `lease_expires_at` column is what makes "machine sleep during a job" survivable: a call
 * is never marked executing in memory only. If the process dies mid-call, the lease simply
 * expires and the call returns to the queue (BDD-004).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  client            TEXT NOT NULL,
  purpose           TEXT,
  submitted_at      INTEGER NOT NULL,
  metadata          TEXT
);

CREATE TABLE IF NOT EXISTS calls (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT REFERENCES jobs(id),
  client                TEXT NOT NULL,
  purpose               TEXT,
  -- 'call' = latency-sensitive, served first. 'job' = batch work. MISSION.md:23
  priority_class        TEXT NOT NULL CHECK (priority_class IN ('call','job')),
  status                TEXT NOT NULL CHECK (status IN ('queued','executing','succeeded','failed','exhausted')),
  prompt                TEXT NOT NULL,
  system_prompt         TEXT,
  params                TEXT NOT NULL,
  min_context_window    INTEGER NOT NULL,
  submitted_at          INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER,
  lease_expires_at      INTEGER,
  attempts              INTEGER NOT NULL DEFAULT 0,
  output                TEXT,
  error_code            TEXT,
  error_message         TEXT,
  provider_id           TEXT,
  model                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_calls_dispatch ON calls(status, priority_class, submitted_at);
CREATE INDEX IF NOT EXISTS idx_calls_job ON calls(job_id);

-- One row per provider attempt. This is what makes a fallback chain auditable: MISSION.md:32
-- requires each attempt and switch to be recorded, and MISSION.md:69 requires each fallback
-- to be visible in the trace.
CREATE TABLE IF NOT EXISTS attempts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id               TEXT NOT NULL REFERENCES calls(id),
  attempt_no            INTEGER NOT NULL,
  provider_id           TEXT NOT NULL,
  model                 TEXT NOT NULL,
  provider_version      TEXT,
  started_at            INTEGER NOT NULL,
  completed_at          INTEGER,
  latency_ms            INTEGER,
  status                TEXT NOT NULL,
  -- 'availability' failures fall through to the next provider; 'content' failures do NOT.
  -- This distinction is load-bearing: see failures.mjs and BDD-013.
  failure_kind          TEXT,
  error_message         TEXT,
  -- The exact payload sent to the provider, post-redaction. NOT the caller's raw state.
  request_payload       TEXT,
  response_text         TEXT,
  -- Tokens Cortex intended to send vs tokens the model actually evaluated. The gap between
  -- these two is the entire point: a truncated call returns HTTP 200 with a plausible wrong
  -- answer, and only this comparison exposes it. BDD-008, BDD-018.
  sent_tokens_estimate  INTEGER,
  evaluated_tokens      INTEGER,
  completion_tokens     INTEGER,
  requested_num_ctx     INTEGER,
  truncation_detected   INTEGER NOT NULL DEFAULT 0,
  -- The provider's own stop signal ('stop' = model chose to end; 'length' = it hit the output
  -- token cap). Distinct from truncation_detected, which is INPUT truncation. 'length' means
  -- the ANSWER was cut off mid-stream -- a thinking model can burn the whole budget before any
  -- JSON is emitted, leaving an empty/partial response that looks like a bad model rather than
  -- a too-small maxTokens. Recording it turns that guess into a fact.
  done_reason           TEXT,
  output_truncated      INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL,
  UNIQUE (call_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_attempts_call ON attempts(call_id);
CREATE INDEX IF NOT EXISTS idx_attempts_provider ON attempts(provider_id, started_at);

-- Read-through cache for deterministic relevance judgments. The key is a hash of the exact
-- (prompt, system prompt, params, model-scope) sent to the model, so a rubric/model/param
-- change misses. source_trace_id keeps every served grade auditable back to the run that
-- produced it. See cache.mjs. Terminal-only by construction: only succeeded, parseable grades
-- are ever written here.
CREATE TABLE IF NOT EXISTS judgment_cache (
  cache_key         TEXT PRIMARY KEY,
  grade             INTEGER NOT NULL,
  reason            TEXT,
  source_trace_id   TEXT NOT NULL,
  model             TEXT,
  created_at        INTEGER NOT NULL,
  hits              INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(path = "data/cortex.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  // Durability over speed: an fsync per commit is cheap next to a ~1-minute model call, and
  // losing the queue to a power cut is exactly the failure this service must not have.
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive, idempotent column migrations for databases created before a column existed.
 *
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so a live on-disk DB predating a
 * new column would be missing it. Each entry adds the column only when absent -- safe to run on
 * every open, and it upgrades a running deployment's DB in place without dropping any rows.
 */
function migrate(db) {
  const columns = db.prepare(`PRAGMA table_info(attempts)`).all().map((c) => c.name);
  const additions = [
    ["done_reason", "TEXT"],
    ["output_truncated", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, decl] of additions) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${decl}`);
  }
}
