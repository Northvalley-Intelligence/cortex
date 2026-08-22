#!/usr/bin/env node
/**
 * Extract Cortex's past relevance judgments from its own trace store,
 * data/cortex.db, table `calls` (purpose='relevance_judgment', status='succeeded').
 *
 * READ-ONLY: opens the db with { readOnly: true } and never issues a write
 * statement. This is Cortex's own historical output -- what we AUDIT, not
 * ground truth (journal 01).
 *
 * Per handoff 00 step 1: parse (query, title) from `prompt`, grade from
 * `output`, join to the latest `attempts` row per call for latency_ms,
 * provider_id, model. Writes one JSON object per line to
 * data/cortex_validations.jsonl. Rows that fail to parse are dropped and
 * counted, never coerced to a fabricated value.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "..", "data", "cortex.db");
const OUT_PATH = path.join(__dirname, "..", "data", "cortex_validations.jsonl");

const QUERY_RE = /Search query:\s*(.+)/;
const TITLE_RE = /Product title:\s*(.+)/;
const GRADE_RE = /"grade"\s*:\s*(\d)/;

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  // calls already carries provider_id/model (the values set on the winning attempt);
  // join to attempts for latency_ms of the latest (highest attempt_no) attempt per call.
  const rows = db
    .prepare(
      `SELECT c.id as call_id, c.prompt as prompt, c.output as output,
              c.provider_id as provider_id, c.model as model,
              a.latency_ms as latency_ms
       FROM calls c
       LEFT JOIN attempts a
         ON a.call_id = c.id
         AND a.attempt_no = (SELECT MAX(a2.attempt_no) FROM attempts a2 WHERE a2.call_id = c.id)
       WHERE c.purpose = 'relevance_judgment'
         AND c.status = 'succeeded'
         AND c.prompt LIKE '%Product title:%'`,
    )
    .all();

  let kept = 0;
  let dropped = 0;
  const dropReasons = {};
  const lines = [];

  for (const row of rows) {
    const qMatch = QUERY_RE.exec(row.prompt);
    const tMatch = TITLE_RE.exec(row.prompt);
    const gMatch = row.output ? GRADE_RE.exec(row.output) : null;

    if (!qMatch || !tMatch || !gMatch) {
      dropped++;
      const reason = !qMatch ? "no_query_match" : !tMatch ? "no_title_match" : "no_grade_match";
      dropReasons[reason] = (dropReasons[reason] || 0) + 1;
      continue;
    }

    const grade = Number(gMatch[1]);
    if (!Number.isInteger(grade)) {
      dropped++;
      dropReasons.non_integer_grade = (dropReasons.non_integer_grade || 0) + 1;
      continue;
    }

    lines.push(
      JSON.stringify({
        query: qMatch[1].trim(),
        title: tMatch[1].trim(),
        cortex_grade: grade,
        provider: row.provider_id ?? null,
        model: row.model ?? null,
        latency_ms: row.latency_ms ?? null,
      }),
    );
    kept++;
  }

  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
  db.close();

  console.log(`Rows scanned: ${rows.length}`);
  console.log(`Kept (parsed): ${kept}`);
  console.log(`Dropped (unparseable): ${dropped}`);
  console.log(`Drop reasons: ${JSON.stringify(dropReasons)}`);
  console.log(`Wrote ${OUT_PATH}`);
}

main();
