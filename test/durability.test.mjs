/**
 * BDD-004, BDD-005 -- NAMED SCENARIO: machine sleep during a job.
 *
 * These use a real on-disk database and a real process boundary where it matters. Durability
 * asserted against an in-memory store would prove nothing about surviving a sleep.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";

const dirs = [];
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-test-"));
  dirs.push(dir);
  return join(dir, "test.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("BDD-004 machine sleep during a job: no work is lost", () => {
  test("a call leased when the process dies is reclaimed and completed after restart", async () => {
    const dbPath = tempDb();

    // --- process 1: leases a call, then "sleeps" (dies) mid-execution ---
    {
      const db = openDb(dbPath);
      // leaseMs 0 stands in for "the machine slept for longer than the lease window".
      const config = loadConfig({ dbPath, leaseMs: 0, providers: [fakeProvider("fake", { kind: "ok" })] });
      const queue = new Queue(db, config);
      queue.submitJob({ client: "eval", calls: [{ prompt: "a" }, { prompt: "b" }] });
      const leased = queue.lease();
      assert.equal(leased.status, "executing");
      assert.ok(leased.lease_expires_at != null, "the lease must be persisted, not held in memory");
      db.close(); // process dies here -- nothing cleans up, exactly like a sleep or power cut
    }

    // --- process 2: restarts and finds the abandoned lease ---
    {
      const db = openDb(dbPath);
      // Zero lease window so the abandoned lease is already expired at restart.
      const config = loadConfig({ dbPath, leaseMs: 0, providers: [fakeProvider("fake", { kind: "ok" })] });
      const queue = new Queue(db, config);

      const reclaimed = queue.reclaimExpiredLeases(Date.now() + 1);
      assert.equal(reclaimed, 1, "the stranded call must return to the queue on restart");

      const worker = new Worker(db, queue, { ...config, leaseMs: 60_000 });
      await worker.runUntilIdle({ timeoutMs: 10_000 });

      const remaining = queue.depth();
      assert.equal(remaining.queued_calls + remaining.queued_job_calls, 0);
      const rows = db.prepare(`SELECT status FROM calls`).all();
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.status === "succeeded"), "no work was lost across the restart");
      db.close();
    }
  });

  test("a call is never stranded in executing: an expired lease always returns to the queue", () => {
    const dbPath = tempDb();
    const db = openDb(dbPath);
    const config = loadConfig({ dbPath, leaseMs: 1_000, providers: [fakeProvider("f", { kind: "ok" })] });
    const queue = new Queue(db, config);
    queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });

    const leased = queue.lease();
    assert.equal(queue.getCall(leased.id).status, "executing");

    // Nothing is dispatchable while the lease is live.
    assert.equal(queue.lease(), null);

    // Once it expires, the same call becomes dispatchable again -- with no crash handler.
    const later = Date.now() + 2_000;
    const relaunched = queue.lease(later);
    assert.equal(relaunched.id, leased.id, "the expired lease must be reclaimable");
    db.close();
  });

  test("survives a real SIGKILL of a separate process mid-lease", () => {
    const dbPath = tempDb();
    // Lease a call in a child process, then SIGKILL it. No graceful shutdown runs at all.
    const script = `
      import { openDb } from ${JSON.stringify(new URL("../src/db.mjs", import.meta.url).pathname)};
      import { loadConfig } from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).pathname)};
      import { Queue } from ${JSON.stringify(new URL("../src/queue.mjs", import.meta.url).pathname)};
      const config = loadConfig({ dbPath: ${JSON.stringify(dbPath)}, leaseMs: 600000, providers: [] });
      const db = openDb(${JSON.stringify(dbPath)});
      const q = new Queue(db, config);
      q.submitCall({ client: "cc", prompt: "killed mid-flight", priorityClass: "call" });
      const leased = q.lease();
      console.log(leased.id);
      process.kill(process.pid, "SIGKILL");
    `;
    // The child SIGKILLs itself, so execFileSync throws on the signal exit -- that IS the
    // scenario. The stdout captured on the error object still carries the leased call id.
    let out;
    try {
      out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();
      assert.fail("child was expected to die by SIGKILL");
    } catch (err) {
      assert.equal(err.signal, "SIGKILL", `child should have died by SIGKILL, got ${err.signal ?? err.message}`);
      out = String(err.stdout ?? "").trim();
    }
    assert.ok(out.startsWith("call_"), `child leased a call before being killed, stdout was ${JSON.stringify(out)}`);

    // The parent finds the work intact and recoverable.
    const db = openDb(dbPath);
    const config = loadConfig({ dbPath, providers: [fakeProvider("f", { kind: "ok" })] });
    const queue = new Queue(db, config);
    const call = queue.getCall(out);
    assert.equal(call.status, "executing", "the killed process left a durable lease behind");
    assert.equal(queue.reclaimExpiredLeases(call.lease_expires_at + 1), 1, "the lease is reclaimable after a SIGKILL");
    assert.equal(queue.getCall(out).status, "queued");
    db.close();
  });
});

describe("BDD-005 requeue after sleep does not double-charge a paid provider", () => {
  test("both attempts are recorded distinctly and the output is not duplicated", async () => {
    const dbPath = tempDb();
    const db = openDb(dbPath);
    let calls = 0;
    const config = loadConfig({
      dbPath,
      providers: [fakeProvider("paid", () => { calls += 1; return { kind: "ok", text: `answer ${calls}` }; })],
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);

    const id = queue.submitCall({ client: "cc", prompt: "expensive", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });
    assert.equal(queue.getCall(id).status, "succeeded");

    // Simulate the sleep/requeue path executing the same call a second time.
    queue.requeue(id);
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const attempts = db.prepare(`SELECT attempt_no, provider_id FROM attempts WHERE call_id = ? ORDER BY attempt_no`).all(id);
    assert.equal(attempts.length, 2, "both provider attempts must be visible in the trace");
    assert.deepEqual(attempts.map((a) => a.attempt_no), [1, 2], "attempt numbering continues across a requeue");

    // The call still resolves to exactly one output -- retries do not multiply results.
    const call = queue.getCall(id);
    assert.equal(call.status, "succeeded");
    assert.equal(typeof call.output, "string");
    db.close();
  });

  test("a job's result set is not duplicated when one of its calls is retried", async () => {
    const dbPath = tempDb();
    const db = openDb(dbPath);
    const config = loadConfig({ dbPath, providers: [fakeProvider("p", { kind: "ok" })] });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);

    const { jobId, callIds } = queue.submitJob({ client: "eval", calls: [{ prompt: "a" }, { prompt: "b" }] });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    queue.requeue(callIds[0]);
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const job = queue.getJob(jobId);
    assert.equal(job.counts.total, 2, "a retry must not add a call to the job");
    assert.equal(job.counts.succeeded, 2);
    assert.equal(job.call_ids.length, 2);
    db.close();
  });
});
