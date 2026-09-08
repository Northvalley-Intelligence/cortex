import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeCell,
  parsePredictions,
  buildDisagreements,
  renderBlindMarkdown,
  renderKey,
  DEFAULT_SEED,
} from "../scripts/disagreement_dump.mjs";
import { parseArgs } from "../scripts/run_arm.mjs";

// Tiny SYNTHETIC sidecar -- no real client data. 6 pairs, 4 disagreements
// (|Δ| = 1, 1, 2, 3), 2 agreements. Row 3 carries pipes and a newline to prove
// the markdown table survives titles like the real dataset's.
const SYNTHETIC = [
  { index: 0, query: "blue widget", item: "Blue Widget, Large", label: 3, pred_grade: 3 },
  { index: 1, query: "blue widget", item: "Red Widget", label: 2, pred_grade: 1 },
  { index: 2, query: "cable", item: "Cable | 6ft | Braided\nBlack", label: 1, pred_grade: 3 },
  { index: 3, query: "lamp", item: "Desk Lamp", label: 0, pred_grade: 0 },
  { index: 4, query: "lamp", item: "Lamp Shade", label: 3, pred_grade: 0 },
  { index: 5, query: "mug", item: "Coffee Mug", label: 1, pred_grade: 2 },
];

test("only disagreeing pairs are emitted, and counts match", () => {
  const d = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  assert.equal(d.evaluated, 6);
  assert.equal(d.disagreements, 4);
  const expected = SYNTHETIC.filter((p) => p.label !== p.pred_grade).length;
  assert.equal(d.disagreements, expected);
  // index1: |2-1|=1, index2: |1-3|=2, index4: |3-0|=3, index5: |1-2|=1
  assert.deepEqual(d.byDelta, { 1: 2, 2: 1, 3: 1 });
  // Rows are numbered 1..n contiguously.
  assert.deepEqual(
    d.rows.map((r) => r.row),
    [1, 2, 3, 4]
  );
});

test("markdown row count equals the disagreement count", () => {
  const d = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  const md = renderBlindMarkdown(d);
  const dataRows = md
    .split("\n")
    .filter((l) => /^\| \d+ \|/.test(l));
  assert.equal(dataRows.length, d.disagreements);
  // Every data row has exactly 5 columns (pipes escaped, so 6 delimiters).
  for (const r of dataRows) {
    const cols = r.replace(/\\\|/g, "").split("|").filter((c, i, a) => i > 0 && i < a.length - 1);
    assert.equal(cols.length, 5, `row has ${cols.length} columns: ${r}`);
  }
});

test("blindness: no arm names anywhere in the markdown", () => {
  const md = renderBlindMarkdown(buildDisagreements(SYNTHETIC, DEFAULT_SEED));
  // The acceptance grep from handoff 07.
  assert.equal(/arm ?d|lora|cortex label/i.test(md), false);
  // Column headers are neutral.
  assert.match(md, /\| Grader A \| Grader B \|/);
});

test("each row's A/B pair is the {label, prediction} set, in one order or the other", () => {
  const d = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  for (const r of d.rows) {
    const src = SYNTHETIC[r.index];
    assert.deepEqual([r.a, r.b].sort(), [src.label, src.pred_grade].sort());
    assert.equal(r.aIs === "cortex" ? r.a : r.b, src.label);
    assert.equal(r.aIs === "arm_d" ? r.a : r.b, src.pred_grade);
    assert.notEqual(r.aIs, r.bIs);
  }
});

test("the orientation actually varies -- it is not a constant column", () => {
  // With a real shuffle both orientations appear across a larger synthetic set.
  const many = Array.from({ length: 200 }, (_, i) => ({
    index: i,
    query: `q${i}`,
    item: `item ${i}`,
    label: 0,
    pred_grade: 3,
  }));
  const d = buildDisagreements(many, DEFAULT_SEED);
  const cortexFirst = d.rows.filter((r) => r.aIs === "cortex").length;
  assert.ok(cortexFirst > 0 && cortexFirst < d.rows.length, `orientation constant: ${cortexFirst}`);
});

test("the key resolves every row back to its grader", () => {
  const d = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  const key = JSON.parse(renderKey(d, DEFAULT_SEED, "synthetic.jsonl"));
  assert.equal(key.seed, DEFAULT_SEED);
  assert.equal(key.rows.length, d.disagreements);
  const mdRows = renderBlindMarkdown(d)
    .split("\n")
    .filter((l) => /^\| \d+ \|/.test(l));
  assert.equal(key.rows.length, mdRows.length);
  for (const kr of key.rows) {
    assert.ok(kr.A === "cortex" || kr.A === "arm_d");
    assert.equal(kr.B, kr.A === "cortex" ? "arm_d" : "cortex");
    const src = SYNTHETIC[kr.index];
    assert.equal(kr.cortex, src.label);
    assert.equal(kr.arm_d, src.pred_grade);
  }
});

test("determinism: same seed reproduces byte-identical output", () => {
  const a = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  const b = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  assert.equal(renderBlindMarkdown(a), renderBlindMarkdown(b));
  assert.equal(renderKey(a, DEFAULT_SEED, "s.jsonl"), renderKey(b, DEFAULT_SEED, "s.jsonl"));
});

test("a different seed changes the orientation but not the rows", () => {
  const a = buildDisagreements(SYNTHETIC, DEFAULT_SEED);
  const b = buildDisagreements(SYNTHETIC, 7);
  assert.deepEqual(
    a.rows.map((r) => r.index),
    b.rows.map((r) => r.index)
  );
  assert.equal(a.disagreements, b.disagreements);
});

test("markdown cell escaping neutralizes pipes and newlines", () => {
  assert.equal(escapeCell("Cable | 6ft"), "Cable \\| 6ft");
  assert.equal(escapeCell("a\nb"), "a b");
  assert.equal(escapeCell(null), "");
});

test("parsePredictions reads JSONL and ignores blank lines", () => {
  const text = SYNTHETIC.map((p) => JSON.stringify(p)).join("\n") + "\n\n";
  assert.deepEqual(parsePredictions(text), SYNTHETIC);
});

// --- run_arm.mjs sidecar flag ------------------------------------------------

test("parseArgs leaves the two positionals intact when the flag is absent", () => {
  const r = parseArgs(["mlx_lora.mjs", "sample.jsonl"], {});
  assert.deepEqual(r.positionals, ["mlx_lora.mjs", "sample.jsonl"]);
  assert.equal(r.predictionsOut, null);
});

test("parseArgs accepts a bare flag, a value, and --flag=value", () => {
  assert.equal(parseArgs(["a", "b", "--predictions-out"], {}).predictionsOut, "");
  assert.equal(parseArgs(["a", "b", "--predictions-out", "/tmp/p.jsonl"], {}).predictionsOut, "/tmp/p.jsonl");
  assert.equal(parseArgs(["a", "b", "--predictions-out=/tmp/p.jsonl"], {}).predictionsOut, "/tmp/p.jsonl");
  // Positionals survive in every form.
  assert.deepEqual(parseArgs(["a", "b", "--predictions-out", "/tmp/p.jsonl"], {}).positionals, ["a", "b"]);
});

test("parseArgs honors ARM_PREDICTIONS_OUT, and the flag wins over the env", () => {
  assert.equal(parseArgs(["a", "b"], { ARM_PREDICTIONS_OUT: "1" }).predictionsOut, "");
  assert.equal(parseArgs(["a", "b"], { ARM_PREDICTIONS_OUT: "/tmp/e.jsonl" }).predictionsOut, "/tmp/e.jsonl");
  assert.equal(
    parseArgs(["a", "b", "--predictions-out", "/tmp/flag.jsonl"], { ARM_PREDICTIONS_OUT: "1" }).predictionsOut,
    "/tmp/flag.jsonl"
  );
  // Off by default: no flag, no env.
  assert.equal(parseArgs(["a", "b"], {}).predictionsOut, null);
});
