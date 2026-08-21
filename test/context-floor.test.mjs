/**
 * BDD-010, BDD-011, BDD-012 -- NAMED SCENARIO: a prompt overflowing the smallest context
 * window fails clearly instead of truncating.
 *
 * The Anti-Demo rule (VALSTRAT-002) is strictest here. The most important test in this file
 * runs against REAL Ollama, because Generation 0 proved the real failure is silent (HTTP 200,
 * wrong answer) and a polite mock that raises a clean exception would let every check below
 * pass while the real system corrupts prompts. When Ollama is not reachable, that test SKIPS
 * loudly rather than passing -- a skipped real-provider check is not the same as a green one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { Queue } from "../src/queue.mjs";
import { Worker } from "../src/worker.mjs";
import { getTrace } from "../src/trace.mjs";
import { eligibleProviders, contextFloor } from "../src/executor.mjs";
import { fakeProvider } from "./helpers/fake-provider.mjs";

const OLLAMA_URL = process.env.CORTEX_OLLAMA_URL || "http://localhost:11434";
const LOCAL_MODEL = process.env.CORTEX_LOCAL_MODEL || "llama3.2:3b";

async function ollamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.models ?? []).some((m) => m.name === LOCAL_MODEL);
  } catch {
    return false;
  }
}

describe("BDD-011 declared context window filters the eligible provider set", () => {
  const providers = [
    fakeProvider("gemini", { kind: "ok" }, { effectiveContextWindow: 1_000_000 }),
    fakeProvider("openrouter", { kind: "ok" }, { effectiveContextWindow: 32_768 }),
    fakeProvider("local", { kind: "ok" }, { effectiveContextWindow: 8_192 }),
  ];

  test("only providers whose effective window satisfies the declared floor are eligible", () => {
    const eligible = eligibleProviders(providers, 16_384);
    assert.deepEqual(eligible.map((p) => p.id), ["gemini", "openrouter"], "local (8192) is excluded by a 16384 floor");
    // The prompt budget is the SMALLEST eligible window, not the largest.
    assert.equal(contextFloor(eligible), 32_768);
  });

  test("the floor is the minimum across eligible providers, so routing can never overflow it", () => {
    assert.equal(contextFloor(eligibleProviders(providers, 1_000)), 8_192, "all three eligible => floor is the smallest");
    assert.equal(contextFloor(eligibleProviders(providers, 40_000)), 1_000_000, "only gemini eligible => its window is the floor");
  });

  test("a requirement no provider satisfies yields no eligible providers", () => {
    assert.deepEqual(eligibleProviders(providers, 2_000_000), []);
  });
});

describe("BDD-010 overflow fails clearly instead of truncating", () => {
  function harness(providers) {
    const db = openDb(":memory:");
    const config = loadConfig({ providers });
    const queue = new Queue(db, config);
    return { db, queue, worker: new Worker(db, queue, config) };
  }

  test("a prompt larger than the floor is rejected before any provider is called", async () => {
    let called = false;
    const { db, queue, worker } = harness([
      fakeProvider("local", () => { called = true; return { kind: "ok" }; }, { effectiveContextWindow: 8_192 }),
    ]);
    // ~8k tokens of prompt at ~3.2 chars/token, floor 8192, plus reserved completion => over.
    const bigPrompt = "word ".repeat(9_000);
    const id = queue.submitCall({ client: "cc", prompt: bigPrompt, minContextWindow: 8_192, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const trace = getTrace(db, id);
    assert.equal(called, false, "an overflowing prompt must never reach a model");
    assert.equal(trace.status, "failed");
    assert.equal(trace.error.code, "context_window_exceeded");
    assert.equal(trace.diagnosis.fault, "caller");
    assert.match(trace.error.message, /Refusing to send/);
  });

  test("a declared window no provider satisfies fails clearly, citing the gap", async () => {
    const { db, queue, worker } = harness([
      fakeProvider("local", { kind: "ok" }, { effectiveContextWindow: 8_192 }),
    ]);
    const id = queue.submitCall({ client: "cc", prompt: "short", minContextWindow: 200_000, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const trace = getTrace(db, id);
    assert.equal(trace.status, "failed");
    assert.equal(trace.error.code, "context_window_exceeded");
    assert.match(trace.error.message, /No configured provider satisfies/);
  });

  test("a prompt that fits the floor is sent normally", async () => {
    const { db, queue, worker } = harness([
      fakeProvider("local", { kind: "ok", text: "answer" }, { effectiveContextWindow: 32_768 }),
    ]);
    const id = queue.submitCall({ client: "cc", prompt: "a reasonable prompt", minContextWindow: 8_192, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });
    assert.equal(getTrace(db, id).status, "succeeded");
  });
});

/**
 * The two defence layers, tested against the REAL model at the level each actually operates:
 *
 *   Layer 1 (pre-flight estimate) is what normally stops an oversized prompt, and BDD-010
 *   above already proves it. It is the desirable outcome: overflow is caught before a
 *   ~1-minute model call is spent. So the executor-level tests above correctly never reach
 *   layer 2.
 *
 *   Layer 2 (post-flight prompt_eval_count check in the ollama adapter) is the backstop for
 *   the case layer 1 cannot cover: an estimate that UNDER-counts real tokenisation. It can
 *   only be exercised by handing the real model a prompt that genuinely exceeds an explicit
 *   num_ctx, so it is tested by calling the adapter directly. This is the exact silent
 *   failure from the Generation 0 probe, now asserted to be caught rather than returned.
 */
describe("BDD-012 REAL OLLAMA: num_ctx is set per call, and real truncation is caught not returned", () => {
  test("LAYER 2 backstop: the real model silently truncating an explicit num_ctx is detected and thrown", async (t) => {
    if (!(await ollamaReachable())) {
      // Loud skip. A real-provider check that cannot run is not a passing check.
      t.skip(`REAL-PROVIDER CHECK SKIPPED: Ollama/${LOCAL_MODEL} not reachable at ${OLLAMA_URL}. ` +
        `This is the anti-demo guardrail for silent truncation and MUST run before phase exit.`);
      return;
    }
    const { callOllama } = await import("../src/providers/ollama.mjs");
    const provider = { id: "local", baseUrl: OLLAMA_URL, model: LOCAL_MODEL };

    const needle = "The secret passphrase is BLUE-HERON-42.";
    const prompt = `${needle} ${"The quick brown fox jumps over the lazy dog. ".repeat(1_200)}\nWhat is the secret passphrase?`;

    // num_ctx=2048 against a ~12k-token prompt: real Ollama returns HTTP 200 with a plausible
    // wrong answer (Generation 0 proved this). Cortex must convert that into a hard failure.
    await assert.rejects(
      () => callOllama({ provider, prompt, systemPrompt: null, params: { maxTokens: 20 }, numCtx: 2_048 }),
      (err) => {
        assert.equal(err.name, "TruncationError", "silent truncation must raise TruncationError, not return an answer");
        assert.ok(err.truncationDetected);
        assert.equal(err.requestedNumCtx, 2_048, "num_ctx was set explicitly, not left to the 4096 default");
        assert.ok(err.evaluatedTokens >= 2_048, `the model evaluated ${err.evaluatedTokens} (>= num_ctx) => it hit the ceiling`);
        return true;
      },
    );
  });

  test("LAYER 2 through the executor: a truncation is attributed to the harness, never the prompt", async () => {
    // Deterministic on purpose. The real model proves truncation is DETECTED (previous test);
    // this proves the executor ATTRIBUTES it correctly, which is a pure branching concern best
    // tested without model-timing flakiness. The fake reproduces the observed shape: HTTP-200-
    // style success turned into a TruncationError with prompt_eval_count pinned to num_ctx.
    const db = openDb(":memory:");
    const config = loadConfig({
      providers: [fakeProvider("local", { kind: "silentTruncation" }, { effectiveContextWindow: 8_192 })],
    });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);

    const id = queue.submitCall({ client: "cc", prompt: "a normal-sized prompt", minContextWindow: 8_192, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 10_000 });

    const trace = getTrace(db, id);
    assert.equal(trace.status, "failed", "a truncated call must fail, never return a plausible answer");
    assert.equal(trace.error.code, "prompt_truncated");
    assert.ok(trace.attempts.at(-1).truncation_detected, "the trace records that truncation happened");
    assert.equal(trace.diagnosis.fault, "harness", "a truncated call is a harness fault, NOT a prompt fault");
    assert.match(trace.diagnosis.do_not_conclude, /Do NOT revise the prompt/);
    db.close();
  });

  test("REAL OLLAMA positive: an explicit large num_ctx overrides the 4096 default and the needle survives", async (t) => {
    if (!(await ollamaReachable())) {
      t.skip(`REAL-PROVIDER CHECK SKIPPED: Ollama/${LOCAL_MODEL} not reachable at ${OLLAMA_URL}.`);
      return;
    }
    const db = openDb(":memory:");
    const local = {
      id: "local", kind: "ollama", baseUrl: OLLAMA_URL, model: LOCAL_MODEL,
      apiKeyEnv: "", timeoutMs: 180_000, effectiveContextWindow: 32_768,
      costPer1kInputUsd: 0, costPer1kOutputUsd: 0,
    };
    const config = loadConfig({ providers: [local], defaultMinContextWindow: 32_768 });
    const queue = new Queue(db, config);
    const worker = new Worker(db, queue, config);

    // ~11k est tokens: comfortably over the 4096 default, comfortably under a 32768 window.
    const needle = "The secret passphrase is BLUE-HERON-42.";
    const prompt = `${needle} ${"The quick brown fox jumps over the lazy dog. ".repeat(800)}\nWhat is the secret passphrase? Answer with just the passphrase.`;
    const id = queue.submitCall({ client: "cc", prompt, minContextWindow: 32_768, params: { maxTokens: 30 }, priorityClass: "call" });
    await worker.runUntilIdle({ timeoutMs: 180_000 });

    const trace = getTrace(db, id);
    assert.equal(trace.status, "succeeded", "with a large num_ctx the whole prompt is evaluated");
    assert.ok(
      trace.attempts[0].tokens.evaluated > 4_096,
      `evaluated ${trace.attempts[0].tokens.evaluated} tokens -- proves Cortex overrode the 4096 default`,
    );
    assert.match(trace.output, /BLUE-HERON-42/, "the needle at the prompt start survived => no truncation");
    assert.equal(trace.attempts[0].truncation_detected, false);
    db.close();
  });
});
