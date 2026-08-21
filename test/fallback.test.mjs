/**
 * BDD-006, BDD-013, BDD-021 -- NAMED SCENARIO: quota exhaustion mid-batch, and the
 * availability-vs-content distinction that makes the chain trustworthy.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { getTrace, listTraces } from "../src/trace.mjs";
import { classifyFailure, shouldFallBack } from "../src/failures.mjs";
import { fakeProvider, sequence } from "./helpers/fake-provider.mjs";

describe("BDD-013 failure classification: availability falls through, content does not", () => {
  test("real observed exhaustion shapes classify as availability", () => {
    const observed = [
      // Both seen live in the Command Center's llm-usage.jsonl.
      'gemini 429: {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
      'openrouter 429: {"error":{"code":429,"message":"Rate limit exceeded: free-models-per-day"}}',
      "local transport: fetch failed",
      "gemini 503: model overloaded",
      "openrouter transport: ECONNREFUSED",
      "gemini 401: API key not valid",
    ];
    for (const message of observed) {
      const kind = classifyFailure({ message });
      assert.equal(kind, "availability", `${message.slice(0, 40)} must be an availability failure`);
      assert.ok(shouldFallBack(kind));
    }
  });

  test("a reachable model's bad answer classifies as content and does NOT fall through", () => {
    const contentFailures = [
      "local: response was not valid JSON",
      "gemini: response contained no choices",
      "judge returned grade 9, outside the 0-3 scale",
    ];
    for (const message of contentFailures) {
      const kind = classifyFailure({ message });
      assert.equal(kind, "content", `${message} must be a content failure`);
      assert.equal(shouldFallBack(kind), false, "content failures must never burn the chain");
    }
  });
});

function chainHarness(providers) {
  const db = openDb(":memory:");
  const config = loadConfig({ providers });
  const queue = new Queue(db, config);
  return { db, queue, worker: new Worker(db, queue, config) };
}

describe("BDD-006 quota exhaustion mid-batch", () => {
  test("the chain fails over to the next provider and records every attempt and switch", async () => {
    const { db, queue, worker } = chainHarness([
      fakeProvider("gemini", { kind: "geminiQuota" }),
      fakeProvider("openrouter", { kind: "openrouterDailyLimit" }),
      fakeProvider("local", { kind: "ok", text: "answered locally" }),
    ]);

    const id = queue.submitCall({ client: "eval", prompt: "judge this", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const trace = getTrace(db, id);
    assert.equal(trace.status, "succeeded");
    assert.equal(trace.output, "answered locally");
    assert.equal(trace.resolved_by.provider, "local", "work continues on the next provider without caller change");

    // MISSION.md:32 -- each attempt and switch is recorded.
    assert.equal(trace.attempts.length, 3, "every provider tried must appear in the trace");
    assert.deepEqual(trace.attempts.map((a) => a.provider), ["gemini", "openrouter", "local"]);
    assert.equal(trace.attempts[0].failure_kind, "availability");
    assert.match(trace.attempts[0].error_message, /RESOURCE_EXHAUSTED|quota/i);
    assert.equal(trace.attempts[1].failure_kind, "availability");
    assert.match(trace.attempts[1].error_message, /free-models-per-day/);
    assert.equal(trace.attempts[2].status, "succeeded");
  });

  test("listTraces preserves the ordered provider path, not just the final resolver (MDE: views must not drop connections)", async () => {
    const { db, queue, worker } = chainHarness([
      fakeProvider("gemini", { kind: "geminiQuota" }),
      fakeProvider("openrouter", { kind: "openrouterDailyLimit" }),
      fakeProvider("local", { kind: "ok" }),
    ]);
    queue.submitCall({ client: "eval", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const [row] = listTraces(db, { limit: 1 }).traces;
    // The list row must carry all three hops in order, not collapse to "local".
    assert.equal(row.provider_id, "local", "final resolver is still recorded");
    assert.deepEqual(row.provider_path.map((a) => a.provider), ["gemini", "openrouter", "local"]);
    assert.equal(row.provider_path[0].status, "failed");
    assert.equal(row.provider_path[0].failure_kind, "availability");
    assert.equal(row.provider_path.at(-1).status, "succeeded");
  });

  test("a single-provider call reports a one-element path", async () => {
    const { db, queue, worker } = chainHarness([fakeProvider("local", { kind: "ok" })]);
    queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });
    const [row] = listTraces(db, { limit: 1 }).traces;
    assert.equal(row.provider_path.length, 1);
    assert.equal(row.provider_path[0].provider, "local");
  });

  test("exhaustion mid-batch switches between calls of one job and the batch still completes", async () => {
    // Gemini serves the first 2 calls, then its daily quota dies. The rest must not fail.
    const { db, queue, worker } = chainHarness([
      fakeProvider("gemini", sequence([{ kind: "ok", text: "g1" }, { kind: "ok", text: "g2" }, { kind: "geminiQuota" }])),
      fakeProvider("local", { kind: "ok", text: "local-answer" }),
    ]);

    const { jobId, callIds } = queue.submitJob({
      client: "eval",
      calls: Array.from({ length: 5 }, (_, i) => ({ prompt: `item ${i}` })),
    });
    await worker.runUntilIdle({ timeoutMs: 20_000 });

    const job = queue.getJob(jobId);
    assert.equal(job.status, "complete");
    assert.equal(job.counts.succeeded, 5, "quota exhaustion mid-batch must not fail the remaining calls");

    const resolvers = callIds.map((id) => getTrace(db, id).resolved_by.provider);
    assert.equal(resolvers.filter((r) => r === "gemini").length, 2, "the first two ran on gemini");
    assert.equal(resolvers.filter((r) => r === "local").length, 3, "the rest fell back to local");

    // The switch itself is auditable, not just the outcome.
    const switched = getTrace(db, callIds[2]);
    assert.equal(switched.attempts.length, 2);
    assert.equal(switched.attempts[0].provider, "gemini");
    assert.equal(switched.attempts[0].failure_kind, "availability");
    assert.equal(switched.attempts[1].provider, "local");
    assert.equal(switched.diagnosis.fault, null);
  });

  test("when every provider is exhausted the call is 'exhausted', not 'failed'", async () => {
    const { db, queue, worker } = chainHarness([
      fakeProvider("gemini", { kind: "geminiQuota" }),
      fakeProvider("openrouter", { kind: "openrouterDailyLimit" }),
    ]);
    const id = queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const trace = getTrace(db, id);
    // 'exhausted' (nobody could answer) must stay distinct from 'failed' (a model answered badly).
    assert.equal(trace.status, "exhausted");
    assert.equal(trace.error.code, "providers_exhausted");
    assert.equal(trace.diagnosis.fault, "availability");
    assert.match(trace.diagnosis.do_not_conclude, /not a prompt or model quality signal/);
  });
});

describe("BDD-013 a content failure must not burn the provider chain", () => {
  test("a bad answer from a reachable model stops the chain and is attributed to prompt-or-model", async () => {
    let localCalled = false;
    const { db, queue, worker } = chainHarness([
      fakeProvider("gemini", { kind: "contentFailure", message: "gemini: response was not valid JSON" }),
      fakeProvider("local", () => { localCalled = true; return { kind: "ok" }; }),
    ]);

    const id = queue.submitCall({ client: "cc", prompt: "bad prompt", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const trace = getTrace(db, id);
    assert.equal(localCalled, false, "a content failure must NOT try the next provider");
    assert.equal(trace.attempts.length, 1, "only the reachable provider is recorded");
    assert.equal(trace.status, "failed");
    assert.equal(trace.error.code, "content_failure");

    // The mission-level point: this stays a prompt/model quality signal and is never
    // laundered into an availability event.
    assert.equal(trace.diagnosis.fault, "prompt_or_model");
    assert.match(trace.diagnosis.next_step, /blame the prompt/i);
  });
});

describe("BDD-021 switching provider requires no change in a calling project", () => {
  test("an identical request runs on either provider and the trace records which handled it", async () => {
    const submit = async (providers) => {
      const { db, queue, worker } = chainHarness(providers);
      // Byte-identical caller request in both runs.
      const id = queue.submitCall({ client: "cc", prompt: "same prompt", params: { temperature: 0.1 }, priorityClass: "call" });
      await worker.runUntilIdle({ timeoutMs: 10_000 });
      return getTrace(db, id);
    };

    const viaCloud = await submit([fakeProvider("gemini", { kind: "ok", text: "cloud" })]);
    const viaLocal = await submit([fakeProvider("local", { kind: "ok", text: "local" })]);

    assert.equal(viaCloud.status, "succeeded");
    assert.equal(viaLocal.status, "succeeded");
    assert.equal(viaCloud.input.prompt, viaLocal.input.prompt, "the caller sent the same thing both times");
    assert.equal(viaCloud.resolved_by.provider, "gemini");
    assert.equal(viaLocal.resolved_by.provider, "local");
  });
});
