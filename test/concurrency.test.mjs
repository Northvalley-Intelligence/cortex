/**
 * Per-provider concurrency (MISSION.md:30) and quota-status derivation (MISSION.md:34) —
 * the two in-scope features that were partial after GEN-001.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { getTrace } from "../src/trace.mjs";
import { providerMetrics } from "../src/metrics.mjs";
import { isQuotaExhaustion } from "../src/failures.mjs";
import { fakeProvider, sequence } from "./helpers/fake-provider.mjs";

/**
 * A provider whose adapter records the peak number of simultaneous in-flight calls it saw.
 * This is how we prove, observably, that cloud calls run in parallel while local serialises —
 * without relying on wall-clock timing assertions.
 */
function trackingProvider(id, { window, cap, holdMs }, tracker) {
  const p = fakeProvider(id, { kind: "ok" }, { effectiveContextWindow: window, maxConcurrency: cap });
  p.__adapter = async ({ provider }) => {
    tracker[id] = (tracker[id] ?? 0) + 1;
    tracker[`${id}_peak`] = Math.max(tracker[`${id}_peak`] ?? 0, tracker[id]);
    await new Promise((r) => setTimeout(r, holdMs));
    tracker[id] -= 1;
    return {
      text: "ok", evaluatedTokens: 50, completionTokens: 5, requestedNumCtx: null,
      truncationDetected: false, providerVersion: provider.model, requestPayload: { model: provider.model },
    };
  };
  return p;
}

describe("per-provider concurrency: cloud parallelises, local serialises", () => {
  test("cloud-primary calls run in parallel while local-primary calls run one at a time", async () => {
    const tracker = {};
    const db = openDb(":memory:");
    // Chain [local, cloud]. A call declaring 8192 is eligible for both -> primary local.
    // A call declaring 500000 is eligible for cloud only -> primary cloud.
    const config = loadConfig({
      providers: [
        trackingProvider("local", { window: 8_192, cap: 1, holdMs: 120 }, tracker),
        trackingProvider("cloud", { window: 1_000_000, cap: 3, holdMs: 120 }, tracker),
      ],
      idleMs: 5,
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);

    // 3 cloud-primary + 3 local-primary, all queued up front.
    for (let i = 0; i < 3; i += 1) queue.submitCall({ client: "c", prompt: `cloud ${i}`, minContextWindow: 500_000, priorityClass: "call" });
    for (let i = 0; i < 3; i += 1) queue.submitCall({ client: "c", prompt: `local ${i}`, minContextWindow: 8_192, priorityClass: "call" });

    worker.start();
    // wait for all six to finish
    for (let i = 0; i < 200; i += 1) {
      const d = queue.depth();
      if (d.queued_calls + d.queued_job_calls + d.executing === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await worker.stop();

    assert.ok(tracker.cloud_peak >= 2, `cloud should have run in parallel; peak was ${tracker.cloud_peak}`);
    assert.equal(tracker.local_peak, 1, `local must serialise; peak was ${tracker.local_peak}`);

    const rows = db.prepare(`SELECT status FROM calls`).all();
    assert.equal(rows.filter((r) => r.status === "succeeded").length, 6, "all six calls completed");
  });

  test("with only a local provider, everything serialises (limit 1)", async () => {
    const tracker = {};
    const db = openDb(":memory:");
    const config = loadConfig({ providers: [trackingProvider("local", { window: 8_192, cap: 1, holdMs: 60 }, tracker)], idleMs: 5 });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    for (let i = 0; i < 4; i += 1) queue.submitCall({ client: "c", prompt: `x${i}`, minContextWindow: 8_192, priorityClass: "call" });
    worker.start();
    for (let i = 0; i < 200; i += 1) {
      const d = queue.depth();
      if (d.queued_calls + d.queued_job_calls + d.executing === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await worker.stop();
    assert.equal(tracker.local_peak, 1, "a single local provider never runs two at once");
  });

  test("priority is preserved: a saturated provider is skipped, not leased-then-requeued", async () => {
    // A call whose primary provider is full must be passed over so a runnable call proceeds,
    // and it must not lose its place or get spuriously requeued.
    const tracker = {};
    const db = openDb(":memory:");
    const config = loadConfig({
      providers: [
        trackingProvider("local", { window: 8_192, cap: 1, holdMs: 150 }, tracker),
        trackingProvider("cloud", { window: 1_000_000, cap: 2, holdMs: 40 }, tracker),
      ],
      idleMs: 5,
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    // Two local-primary (serialise) + two cloud-primary (parallel). While local #2 waits for
    // local #1, the cloud calls should still get through.
    queue.submitCall({ client: "c", prompt: "local1", minContextWindow: 8_192, priorityClass: "call" });
    queue.submitCall({ client: "c", prompt: "local2", minContextWindow: 8_192, priorityClass: "call" });
    queue.submitCall({ client: "c", prompt: "cloud1", minContextWindow: 500_000, priorityClass: "call" });
    queue.submitCall({ client: "c", prompt: "cloud2", minContextWindow: 500_000, priorityClass: "call" });
    worker.start();
    for (let i = 0; i < 200; i += 1) {
      const d = queue.depth();
      if (d.queued_calls + d.queued_job_calls + d.executing === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await worker.stop();
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM calls WHERE status='succeeded'`).get().n, 4, "all four completed");
    assert.equal(tracker.cloud_peak, 2, "both cloud calls ran together despite local being busy");
    assert.equal(tracker.local_peak, 1, "local stayed serial");
  });
});

describe("quota status is derived from provider failures (MISSION.md:34)", () => {
  test("isQuotaExhaustion recognises the real observed shapes and excludes non-quota failures", () => {
    assert.ok(isQuotaExhaustion('gemini 429: {"status":"RESOURCE_EXHAUSTED"}'));
    assert.ok(isQuotaExhaustion("openrouter 429: Rate limit exceeded: free-models-per-day"));
    assert.equal(isQuotaExhaustion("local transport: ECONNREFUSED"), false, "a transport error is not a quota signal");
    assert.equal(isQuotaExhaustion("response was not valid JSON"), false, "a content failure is not a quota signal");
  });

  test("a provider whose most recent attempt was a quota failure reports quota_status 'exhausted'", async () => {
    const db = openDb(":memory:");
    const config = loadConfig({
      providers: [
        fakeProvider("gemini", { kind: "geminiQuota" }),
        fakeProvider("local", { kind: "ok" }),
      ],
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    const id = queue.submitCall({ client: "c", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const gem = providerMetrics(db).find((p) => p.provider === "gemini");
    assert.equal(gem.quota_status, "exhausted", "gemini's 429 makes its quota status exhausted");
    assert.ok(gem.quota_hits >= 1);
    // The call still succeeded on fallback -- quota status is about the provider, not the call.
    assert.equal(getTrace(db, id).status, "succeeded");
    const local = providerMetrics(db).find((p) => p.provider === "local");
    assert.equal(local.quota_status, "ok", "local never hit quota");
  });

  test("a provider that hit quota earlier but is answering now reports 'recovered', not 'exhausted'", async () => {
    const db = openDb(":memory:");
    // gemini: quota, quota, then OK. Its most recent attempt succeeds.
    const config = loadConfig({
      providers: [fakeProvider("gemini", sequence([{ kind: "geminiQuota" }, { kind: "geminiQuota" }, { kind: "ok" }]))],
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);
    for (let i = 0; i < 3; i += 1) {
      queue.submitCall({ client: "c", prompt: `x${i}`, priorityClass: "call" });
      await worker.runUntilIdle({ timeoutMs: 10_000 });
    }
    const gem = providerMetrics(db).find((p) => p.provider === "gemini");
    assert.equal(gem.quota_status, "recovered", "earlier quota hits + a current success => recovered");
    assert.equal(gem.quota_hits, 2);
  });
});
