/**
 * Validation Gate runner.
 *
 * Maps the categories in .mde/validation-strategy.json to the test files that exercise them,
 * runs them, and prints a category-level pass/fail summary. Phase exit requires two clean
 * passes (MISSION.md / VALSTRAT-002), and the real-provider checks (VS-CTX, live scenarios)
 * are never skippable in pass 2.
 *
 * Deliberately thin: it shells out to `node --test` rather than reimplementing a runner, so
 * the gate result and the test result can never disagree.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CATEGORY_TESTS = {
  "VS-FUNC (Functional)": ["test/queue-priority.test.mjs", "test/api.test.mjs"],
  "VS-CONTRACT guards (caller-review regressions)": ["test/contract-guards.test.mjs"],
  "VS-DURABLE (Durability)": ["test/durability.test.mjs"],
  "VS-FUNC concurrency + quota status": ["test/concurrency.test.mjs"],
  "VS-FUNC net-failure semantics + data pruning": ["test/maintenance.test.mjs"],
  "VS-FUNC judgment cache (relevance)": ["test/cache.test.mjs"],
  "VS-CTX (Context floor, REAL Ollama)": ["test/context-floor.test.mjs"],
  "VS-TRACE + VS-MISSION (Trace integrity / diagnosis)": ["test/trace-integrity.test.mjs"],
  "VS-FUNC fallback + VS-CONTRACT semantics": ["test/fallback.test.mjs"],
  "VS-IR (NDCG / relevance)": ["test/relevance.test.mjs"],
};

function ollamaReachable() {
  const r = spawnSync("curl", ["-s", "--max-time", "3", "http://localhost:11434/api/tags"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("llama3.2:3b");
}

const passLabel = process.argv[2] || "pass";
const strat = JSON.parse(readFileSync(new URL("../.mde/validation-strategy.json", import.meta.url)));

console.log(`\n=== Cortex Validation Gate (${passLabel}) — strategy ${strat.strategy_id} ===\n`);

if (!ollamaReachable()) {
  console.error(
    "BLOCKED: real Ollama (llama3.2:3b) is not reachable at localhost:11434.\n" +
    "VS-CTX is the anti-demo guardrail for silent truncation and MUST run against the real\n" +
    "provider before phase exit. A skipped real-provider check is not a pass. Aborting.",
  );
  process.exit(2);
}

const results = [];
for (const [category, files] of Object.entries(CATEGORY_TESTS)) {
  const r = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env.local", "--test", ...files],
    { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
  );
  const out = r.stdout + r.stderr;
  // Node's test runner prints summary lines as "ℹ tests N" / "ℹ fail N".
  const testsLine = (out.match(/tests (\d+)/) || [])[1] ?? "?";
  const failLine = (out.match(/\bfail (\d+)/) || [])[1] ?? "?";
  const pass = failLine === "0" && r.status === 0;
  results.push({ category, pass, tests: testsLine, fail: failLine });
  console.log(`${pass ? "PASS" : "FAIL"}  ${category}  (${testsLine} tests, ${failLine} failed)`);
  if (!pass) console.log(out.split("\n").filter((l) => l.includes("✖") || l.includes("Assertion")).slice(0, 10).join("\n"));
}

const allPass = results.every((r) => r.pass);
console.log(`\n=== Gate ${passLabel}: ${allPass ? "PASS" : "FAIL"} ===`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} categories passed\n`);
process.exit(allPass ? 0 : 1);
