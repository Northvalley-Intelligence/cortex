/**
 * BDD-002, BDD-003, BDD-014, BDD-015 -- queue semantics.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";

function harness(overrides = {}) {
  const db = openDb(":memory:");
  const config = loadConfig({
    dbPath: ":memory:",
    providers: [fakeProvider("fake", { kind: "ok" })],
    ...overrides,
  });
  const queue = new Queue(db, config);
  return { db, config, queue, worker: new Worker(db, queue, config) };
}

describe("BDD-003 live call under load: a call is served ahead of queued job work", () => {
  test("a call submitted after a batch is dispatched before the batch's remaining work", () => {
    const { queue } = harness();

    // A batch is already queued -- the real-world case is ~10 calls at ~1 min each.
    const { callIds: jobCalls } = queue.submitJob({
      client: "eval",
      calls: Array.from({ length: 10 }, (_, i) => ({ prompt: `batch item ${i}` })),
    });

    // A live command arrives while the batch waits.
    const liveCall = queue.submitCall({ client: "command-center", prompt: "route this", priorityClass: "call" });

    const first = queue.lease();
    assert.equal(first.id, liveCall, "the live call must be dispatched before any job-call");
    assert.equal(first.priority_class, "call");
    assert.ok(jobCalls.length === 10);
  });

  test("a live call does not wait behind a batch even when the batch was submitted first", () => {
    const { queue } = harness();
    queue.submitJob({ client: "eval", calls: [{ prompt: "a" }, { prompt: "b" }] });
    const live = queue.submitCall({ client: "cc", prompt: "urgent", priorityClass: "call" });
    assert.equal(queue.lease().id, live);
  });
});

describe("BDD-015 fairness floor: background jobs keep advancing under continuous call load", () => {
  test("a job-call is dispatched at least every Nth dispatch despite unending calls", () => {
    const { queue } = harness({ fairnessEveryNDispatches: 4 });
    queue.submitJob({ client: "eval", calls: Array.from({ length: 20 }, (_, i) => ({ prompt: `j${i}` })) });

    // Continuous live-call pressure: a new call is always waiting.
    const dispatched = [];
    for (let i = 0; i < 12; i += 1) {
      queue.submitCall({ client: "cc", prompt: `call ${i}`, priorityClass: "call" });
      const leased = queue.lease();
      dispatched.push(leased.priority_class);
      queue.complete(leased.id, { status: "succeeded", output: "x" });
    }

    const jobDispatches = dispatched.filter((c) => c === "job").length;
    assert.ok(
      jobDispatches >= 3,
      `expected the fairness floor to force >=3 job dispatches in 12 under constant call load, got ${jobDispatches} (${dispatched.join(",")})`,
    );
  });

  test("without the fairness floor a steady call stream would starve the job (control)", () => {
    // Establishes that the floor is doing real work rather than the test passing by accident.
    const { queue } = harness({ fairnessEveryNDispatches: 0 });
    queue.submitJob({ client: "eval", calls: [{ prompt: "j0" }] });
    const dispatched = [];
    for (let i = 0; i < 6; i += 1) {
      queue.submitCall({ client: "cc", prompt: `c${i}`, priorityClass: "call" });
      const leased = queue.lease();
      dispatched.push(leased.priority_class);
      queue.complete(leased.id, { status: "succeeded", output: "x" });
    }
    assert.equal(dispatched.filter((c) => c === "job").length, 0, "control: job starves with the floor disabled");
  });
});

describe("BDD-002 a job resolves to per-call IDs and completes automatically", () => {
  test("job exposes its call ids and only reports complete when every call is terminal", async () => {
    const { queue, worker } = harness();
    const { jobId, callIds } = queue.submitJob({
      client: "eval",
      calls: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
    });

    let job = queue.getJob(jobId);
    assert.equal(job.call_ids.length, 3);
    assert.deepEqual(job.call_ids, callIds);
    assert.equal(job.status, "in_progress", "a job with queued calls is not complete");

    await worker.runUntilIdle({ timeoutMs: 10_000 });

    job = queue.getJob(jobId);
    assert.equal(job.status, "complete");
    assert.equal(job.counts.succeeded, 3);
    assert.equal(job.counts.total, 3);
  });

  test("partial completion is retrievable rather than collapsed into a single verdict", async () => {
    const db = openDb(":memory:");
    // Third call fails on content; the first two succeed.
    let n = 0;
    const config = loadConfig({
      providers: [
        fakeProvider("flaky", () => (++n === 3 ? { kind: "contentFailure" } : { kind: "ok" })),
      ],
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    const { jobId } = queue.submitJob({
      client: "eval",
      calls: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
    });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const job = queue.getJob(jobId);
    assert.equal(job.status, "complete", "the job is complete once all calls are terminal");
    assert.equal(job.counts.succeeded, 2);
    assert.equal(job.counts.failed, 1);
    // The whole point: 2-of-3 is visible, not flattened to "failed".
    assert.notEqual(job.counts.succeeded, 0, "partial success must not be reported as total failure");
  });
});

describe("BDD-014 work submitted while no provider is available is queued, not rejected", () => {
  test("a call is accepted and retrievable when every provider is down, then runs on recovery", async () => {
    const db = openDb(":memory:");
    let down = true;
    const config = loadConfig({
      providers: [fakeProvider("local", () => (down ? { kind: "transport" } : { kind: "ok" }))],
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);

    const id = queue.submitCall({ client: "cc", prompt: "later", priorityClass: "call" });
    assert.ok(id, "submission is accepted even with no provider up");

    await worker.runUntilIdle({ timeoutMs: 10_000 });
    let call = queue.getCall(id);
    assert.equal(call.status, "exhausted", "all providers unavailable => exhausted, not lost");

    // Machine comes back; the operator resubmits the same work.
    down = false;
    queue.requeue(id);
    await worker.runUntilIdle({ timeoutMs: 10_000 });
    call = queue.getCall(id);
    assert.equal(call.status, "succeeded");
  });
});
