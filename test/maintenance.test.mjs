/**
 * Net-vs-provider failure semantics, per-interval provider failure rates, and data pruning.
 * Ferosh: a provider failing that fallback recovers is NOT a system failure; and there must be
 * a way to reclaim space.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { callMetrics, providerMetrics } from "../src/metrics.mjs";
import { storageStats, prune, prunablePreview } from "../src/maintenance.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";

const dirs = [];
function tempDb() { const d = mkdtempSync(join(tmpdir(), "cortex-maint-")); dirs.push(d); return join(d, "t.db"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("net failure is distinct from provider failure", () => {
  test("a call gemini fails but openrouter recovers counts as succeeded + recovered, NOT net failed", async () => {
    const db = openDb(":memory:");
    const config = loadConfig({ providers: [fakeProvider("gemini", { kind: "geminiQuota" }), fakeProvider("openrouter", { kind: "ok" })] });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const c = callMetrics(db);
    assert.equal(c.net_failed, 0, "the caller saw success — net failure must be 0");
    assert.equal(c.recovered_by_fallback, 1, "the recovered provider failure is counted separately");
    assert.equal(c.succeeded, 1);

    // But gemini's own failure rate reflects its attempt failure (over the window).
    const gem = providerMetrics(db).find((p) => p.provider === "gemini");
    assert.equal(gem.failure_rate, 1, "gemini failed its one attempt");
    assert.equal(gem.availability_failure_rate, 1, "and it was an availability failure");
    assert.equal(gem.attempts, 1);
    const orc = providerMetrics(db).find((p) => p.provider === "openrouter");
    assert.equal(orc.failure_rate, 0, "openrouter succeeded");
  });

  test("a call where every provider fails IS a net (system) failure", async () => {
    const db = openDb(":memory:");
    const config = loadConfig({ providers: [fakeProvider("gemini", { kind: "geminiQuota" }), fakeProvider("openrouter", { kind: "openrouterDailyLimit" })] });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const c = callMetrics(db);
    assert.equal(c.net_failed, 1, "no provider answered — the caller saw a failure");
    assert.equal(c.recovered_by_fallback, 0);
    assert.equal(c.exhausted, 1);
  });

  test("provider metrics are scoped to the caller's window (one coherent period for the whole view)", async () => {
    const db = openDb(":memory:");
    const config = loadConfig({ providers: [fakeProvider("local", { kind: "ok" })] });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    queue.submitCall({ client: "cc", prompt: "recent", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    // Full-window view sees the attempt.
    const all = providerMetrics(db)[0];
    assert.equal(all.attempts, 1);
    assert.equal(all.failure_rate, 0);

    // A window that starts in the future excludes it — the provider drops out entirely rather
    // than showing a stale all-time number, so the view's period is unambiguous.
    const future = providerMetrics(db, Date.now() + 60_000);
    assert.equal(future.length, 0, "no attempts in the window => provider not shown");
  });
});

describe("data pruning reclaims space and never drops in-flight work", () => {
  function seed(db, config, n) {
    const queue = new Queue(db, config);
    for (let i = 0; i < n; i += 1) queue.submitCall({ client: "cc", prompt: `x${i}`, priorityClass: "call" });
    return queue;
  }

  test("prune all removes terminal calls, attempts, and their jobs, and shrinks the db", async () => {
    const dbPath = tempDb();
    const db = openDb(dbPath);
    const config = loadConfig({ dbPath, providers: [fakeProvider("local", { kind: "ok" })] });
    const queue = seed(db, config, 20);
    queue.submitJob({ client: "eval", calls: [{ prompt: "a" }, { prompt: "b" }] });
    const worker = new Worker(db, queue, config);
    await worker.runUntilIdle({ timeoutMs: 20_000 });

    const before = storageStats(db, dbPath);
    assert.ok(before.calls >= 22 && before.attempts >= 22 && before.jobs === 1);
    const sizeBefore = statSync(dbPath).size;

    const res = prune(db, { all: true, dbPath });
    assert.equal(res.deleted_calls, before.calls);
    assert.ok(res.deleted_attempts >= before.attempts);
    assert.equal(res.deleted_jobs, 1);

    const after = storageStats(db, dbPath);
    assert.equal(after.calls, 0);
    assert.equal(after.attempts, 0);
    assert.equal(after.jobs, 0);
    assert.ok(statSync(dbPath).size <= sizeBefore, "VACUUM reclaimed disk");
    db.close();
  });

  test("prune older-than keeps recent calls and only removes old ones", async () => {
    const dbPath = tempDb();
    const db = openDb(dbPath);
    const config = loadConfig({ dbPath, providers: [fakeProvider("local", { kind: "ok" })] });
    const queue = seed(db, config, 3);
    const worker = new Worker(db, queue, config);
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    // Nothing is older than 7 days yet.
    assert.equal(prunablePreview(db, { olderThanMs: 7 * 86_400_000 }), 0);
    const res = prune(db, { olderThanMs: 7 * 86_400_000, dbPath });
    assert.equal(res.deleted_calls, 0, "recent calls are kept");
    assert.equal(storageStats(db, dbPath).calls, 3);

    // Backdate them and prune again.
    db.prepare(`UPDATE calls SET submitted_at = 1`).run();
    const res2 = prune(db, { olderThanMs: 7 * 86_400_000, dbPath });
    assert.equal(res2.deleted_calls, 3);
    db.close();
  });

  test("in-flight (non-terminal) calls are never pruned", () => {
    const dbPath = tempDb();
    const db = openDb(dbPath);
    const config = loadConfig({ dbPath, providers: [fakeProvider("local", { kind: "ok" })] });
    const queue = new Queue(db, config);
    queue.submitCall({ client: "cc", prompt: "queued and never run", priorityClass: "call" });
    const res = prune(db, { all: true, dbPath });
    assert.equal(res.deleted_calls, 0, "a queued call is not terminal and must survive a prune-all");
    assert.equal(storageStats(db, dbPath).calls, 1);
    db.close();
  });

  test("prune requires an explicit target", () => {
    const db = openDb(":memory:");
    assert.throws(() => prune(db, {}), /requires all:true or olderThanMs/);
  });
});
