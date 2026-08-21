/**
 * BDD-007, BDD-008, BDD-009, BDD-016, BDD-018 -- the trace is the product.
 *
 * These assert the properties that make a trace trustworthy: it is complete, it records what
 * the model actually consumed, its metrics reconcile with the raw rows, it holds no secrets,
 * and it can tell a prompt fault from a harness fault (the mission's central thesis).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { getTrace } from "../src/trace.mjs";
import { summary, providerMetrics } from "../src/metrics.mjs";
import { redact, findSecrets } from "../src/redact.mjs";
import { fakeProvider, sequence } from "./helpers/fake-provider.mjs";

function harness(providers, overrides = {}) {
  const db = openDb(":memory:");
  const config = loadConfig({ providers, ...overrides });
  const queue = new Queue(db, config);
  return { db, queue, worker: new Worker(db, queue, config) };
}

describe("BDD-007 every terminal call has a complete trace", () => {
  test("succeeded, failed, and exhausted calls each carry the full record", async () => {
    const { db, queue, worker } = harness([
      fakeProvider("p", sequence([
        { kind: "ok", text: "good", evaluatedTokens: 120 },
        { kind: "contentFailure", message: "p: bad json" },
        { kind: "transport" },
      ])),
    ]);
    const ids = [
      queue.submitCall({ client: "cc", purpose: "route", prompt: "one", priorityClass: "call" }),
      queue.submitCall({ client: "cc", purpose: "route", prompt: "two", priorityClass: "call" }),
      queue.submitCall({ client: "cc", purpose: "route", prompt: "three", priorityClass: "call" }),
    ];
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    for (const id of ids) {
      const t = getTrace(db, id);
      assert.ok(["succeeded", "failed", "exhausted"].includes(t.status));
      assert.ok(t.input.prompt, "input prompt recorded");
      assert.ok(t.timing.submitted_at, "submission time recorded");
      assert.ok(t.attempts.length >= 1, "at least one provider attempt recorded");
      for (const a of t.attempts) {
        assert.ok(a.provider, "each attempt names its provider");
        assert.ok(a.model, "each attempt names its model");
        assert.ok(a.status, "each attempt has a status");
        assert.ok(typeof a.latency_ms === "number", "each attempt has timing");
      }
      assert.ok(t.diagnosis, "every trace carries a diagnosis");
    }
  });
});

describe("BDD-008 the trace records what the model actually consumed", () => {
  test("evaluated tokens are recorded alongside the sent estimate", async () => {
    const { db, queue, worker } = harness([fakeProvider("p", { kind: "ok", evaluatedTokens: 733 })]);
    const id = queue.submitCall({ client: "cc", prompt: "measure me", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const t = getTrace(db, id);
    assert.equal(t.attempts[0].tokens.evaluated, 733, "evaluated (consumed) token count is recorded");
    assert.ok(typeof t.attempts[0].tokens.sent_estimate === "number", "the sent estimate is recorded for comparison");
  });

  test("a truncated call is recorded as a failure, not a success", async () => {
    const { db, queue, worker } = harness([
      fakeProvider("local", { kind: "silentTruncation" }, { effectiveContextWindow: 8_192 }),
    ]);
    const id = queue.submitCall({ client: "cc", prompt: "x", minContextWindow: 8_192, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const t = getTrace(db, id);
    assert.equal(t.status, "failed", "truncation is a failure even though the model returned HTTP 200");
    assert.ok(t.attempts[0].truncation_detected);
  });
});

describe("BDD-016 dashboard metrics reconcile exactly with the raw trace rows", () => {
  test("recomputing provider aggregates from attempts matches the metrics output", async () => {
    const { db, queue, worker } = harness([
      fakeProvider("gemini", sequence([{ kind: "ok" }, { kind: "geminiQuota" }, { kind: "ok" }])),
      fakeProvider("local", { kind: "ok" }),
    ]);
    for (let i = 0; i < 3; i += 1) queue.submitCall({ client: "cc", prompt: `p${i}`, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const metrics = providerMetrics(db);
    // Recompute independently from the raw table -- the metric must not diverge from the record.
    const rawRows = db.prepare(`SELECT provider_id, status FROM attempts`).all();
    for (const m of metrics) {
      const raw = rawRows.filter((r) => r.provider_id === m.provider);
      assert.equal(m.attempts, raw.length, `${m.provider} attempt count must match raw rows`);
      assert.equal(m.succeeded, raw.filter((r) => r.status === "succeeded").length);
      assert.equal(m.failed, raw.filter((r) => r.status === "failed").length);
    }

    const gem = metrics.find((m) => m.provider === "gemini");
    assert.equal(gem.attempts, 3);
    assert.equal(gem.availability_failures, 1, "the one quota failure is counted");
    assert.ok(gem.availability_failure_rate > 0, "an unreliable provider shows a non-zero failure rate");
  });

  test("the truncated_calls metric is zero in healthy operation and non-zero when Cortex truncates", async () => {
    const clean = harness([fakeProvider("p", { kind: "ok" })]);
    clean.queue.submitCall({ client: "cc", prompt: "ok", priorityClass: "call" });
    await clean.worker.runUntilIdle({ timeoutMs: 10_000 });
    assert.equal(summary(clean.db).calls.truncated_calls, 0, "healthy operation: no truncations");

    const broken = harness([fakeProvider("local", { kind: "silentTruncation" }, { effectiveContextWindow: 8_192 })]);
    broken.queue.submitCall({ client: "cc", prompt: "x", minContextWindow: 8_192, priorityClass: "call" });
    await broken.worker.runUntilIdle({ timeoutMs: 10_000 });
    assert.equal(summary(broken.db).calls.truncated_calls, 1, "the one metric whose correct value is known in advance");
  });
});

describe("BDD-009 / BDD-018 the trace distinguishes a prompt fault from a harness fault", () => {
  test("a content failure is diagnosed as a prompt/model quality signal (blame the prompt)", async () => {
    const { db, queue, worker } = harness([fakeProvider("gemini", { kind: "contentFailure", message: "gemini: not valid JSON" })]);
    const id = queue.submitCall({ client: "eval", prompt: "poorly worded prompt", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const t = getTrace(db, id);
    assert.equal(t.diagnosis.fault, "prompt_or_model");
    assert.match(t.diagnosis.next_step, /blame the prompt/i);
    // The evidence needed to actually revise the prompt is present.
    assert.ok(t.input.prompt, "the exact prompt is retrievable for revision");
  });

  test("a truncation is diagnosed as a harness fault with an explicit do-not-blame-the-prompt note", async () => {
    const { db, queue, worker } = harness([fakeProvider("local", { kind: "silentTruncation" }, { effectiveContextWindow: 8_192 })]);
    const id = queue.submitCall({ client: "cc", prompt: "x", minContextWindow: 8_192, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const t = getTrace(db, id);
    assert.equal(t.diagnosis.fault, "harness", "the inverse drill: a harness fault is NOT attributed to the prompt");
    assert.equal(t.diagnosis.confident, true);
    assert.match(t.diagnosis.do_not_conclude, /Do NOT revise the prompt/);
  });

  test("output truncation (done_reason=length) is diagnosed as a caller budget fault, not a bad model", async () => {
    // The qwen3-thinking-model case: HTTP 200, empty answer, the whole token budget consumed.
    // The call 'succeeds' but the completion was severed, so it must NOT read as model quality.
    const { db, queue, worker } = harness([
      fakeProvider("local", { kind: "outputTruncated", maxTokens: 200 }),
    ]);
    const id = queue.submitCall({ client: "eval", prompt: "judge this", priorityClass: "call", params: { maxTokens: 200 } });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const t = getTrace(db, id);
    assert.equal(t.status, "succeeded", "Cortex returns the (partial) output rather than inventing a failure");
    assert.equal(t.attempts[0].output_truncated, true, "the severed-output signal is recorded on the attempt");
    assert.equal(t.attempts[0].done_reason, "length");
    assert.equal(t.diagnosis.fault, "caller", "the fix is the caller's token budget, not the prompt or the model");
    assert.equal(t.diagnosis.confident, true);
    assert.match(t.diagnosis.next_step, /budget|maxTokens|thinking/i);
    // It must NOT be diagnosed as a clean success that hides the truncation.
    assert.notEqual(t.diagnosis.summary, "Call succeeded.");
  });

  test("does not trigger fallback: an output-truncated success stays on the first provider", async () => {
    const { db, queue, worker } = harness([
      fakeProvider("gemini", { kind: "outputTruncated", maxTokens: 120 }),
      fakeProvider("local", { kind: "ok", text: "second provider answer" }),
    ]);
    const id = queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const t = getTrace(db, id);
    assert.equal(t.attempts.length, 1, "output truncation is not an availability failure -- no fallback");
    assert.equal(t.resolved_by.provider, "gemini");
  });

  test("exhaustion is diagnosed as availability, explicitly not a quality signal", async () => {
    const { db, queue, worker } = harness([fakeProvider("gemini", { kind: "geminiQuota" })]);
    const id = queue.submitCall({ client: "cc", prompt: "x", priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });
    const t = getTrace(db, id);
    assert.equal(t.diagnosis.fault, "availability");
    assert.match(t.diagnosis.do_not_conclude, /not a prompt or model quality signal/);
  });
});

describe("VS-TRACE the trace store holds no credential-shaped strings", () => {
  test("redact removes API keys from strings, nested objects, and known-key headers", () => {
    const input = {
      messages: [{ role: "system", content: "here is my key sk-abcdef0123456789ABCDEF and more text" }],
      headers: { Authorization: "Bearer supersecrettoken12345", "content-type": "application/json" },
      config: { api_key: "AIzaSyD-verysecretgoogleapikey12345" },
    };
    const out = redact(input);
    const serialized = JSON.stringify(out);
    assert.doesNotMatch(serialized, /sk-abcdef0123456789ABCDEF/, "OpenAI-style key removed");
    assert.doesNotMatch(serialized, /supersecrettoken12345/, "bearer token removed");
    assert.doesNotMatch(serialized, /verysecretgoogleapikey/, "google key removed");
    assert.equal(out.headers["content-type"], "application/json", "non-secret fields are preserved");
    assert.equal(findSecrets(serialized).length, 0, "the secret scanner finds nothing in the redacted output");
  });

  test("a live env credential appearing verbatim in a prompt is scrubbed", () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIzaTESTKEY_do_not_log_me_1234567890";
    try {
      const out = redact({ prompt: `oops I pasted my key AIzaTESTKEY_do_not_log_me_1234567890 into the prompt` });
      assert.doesNotMatch(JSON.stringify(out), /do_not_log_me/, "an env secret is scrubbed even inside free text");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });
});
