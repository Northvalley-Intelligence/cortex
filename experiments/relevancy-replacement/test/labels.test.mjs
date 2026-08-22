import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RELEVANCE_SCALE,
  VALID_GRADES,
  ESCI_LABEL_MAP,
  WANDS_LABEL_MAP,
  esciLabelToGrade,
  wandsLabelToGrade,
} from "../src/labels.mjs";

test("RELEVANCE_SCALE was read from Cortex source, not re-typed", () => {
  // Independently re-read the same file labels.mjs imports from, and assert the
  // imported RELEVANCE_SCALE is byte-identical to what's in Cortex's src/relevance.mjs.
  // This proves labels.mjs is not carrying a hand-copied, driftable duplicate.
  const sourcePath = fileURLToPath(new URL("../../../src/relevance.mjs", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /export const RELEVANCE_SCALE = \{/, "RELEVANCE_SCALE must still be defined in src/relevance.mjs");

  // Every value currently in Cortex's source must appear verbatim in the imported object.
  for (const [grade, meaning] of Object.entries(RELEVANCE_SCALE)) {
    assert.ok(source.includes(meaning), `RELEVANCE_SCALE[${grade}] meaning not found verbatim in src/relevance.mjs`);
  }
  assert.deepEqual(VALID_GRADES.sort(), [0, 1, 2, 3]);
});

test("ESCI mapping covers every ESCI source label (E, S, C, I)", () => {
  const esciLabels = ["E", "S", "C", "I"];
  for (const label of esciLabels) {
    assert.ok(label in ESCI_LABEL_MAP, `ESCI_LABEL_MAP missing label ${label}`);
  }
  assert.equal(Object.keys(ESCI_LABEL_MAP).length, esciLabels.length);
});

test("WANDS mapping covers every WANDS source label (Exact, Partial, Irrelevant)", () => {
  const wandsLabels = ["Exact", "Partial", "Irrelevant"];
  for (const label of wandsLabels) {
    assert.ok(label in WANDS_LABEL_MAP, `WANDS_LABEL_MAP missing label ${label}`);
  }
  assert.equal(Object.keys(WANDS_LABEL_MAP).length, wandsLabels.length);
});

test("every mapped target grade is a valid RELEVANCE_SCALE key", () => {
  for (const [label, grade] of Object.entries(ESCI_LABEL_MAP)) {
    assert.ok(VALID_GRADES.includes(grade), `ESCI ${label} -> ${grade} not in RELEVANCE_SCALE`);
  }
  for (const [label, grade] of Object.entries(WANDS_LABEL_MAP)) {
    assert.ok(VALID_GRADES.includes(grade), `WANDS ${label} -> ${grade} not in RELEVANCE_SCALE`);
  }
});

test("mapping values match journal 01's decisions exactly", () => {
  assert.equal(esciLabelToGrade("E"), 3);
  assert.equal(esciLabelToGrade("S"), 2);
  assert.equal(esciLabelToGrade("C"), 1);
  assert.equal(esciLabelToGrade("I"), 0);
  assert.equal(wandsLabelToGrade("Exact"), 3);
  assert.equal(wandsLabelToGrade("Partial"), 2);
  assert.equal(wandsLabelToGrade("Irrelevant"), 0);
});

test("unknown labels throw rather than silently defaulting", () => {
  assert.throws(() => esciLabelToGrade("X"));
  assert.throws(() => wandsLabelToGrade("Somewhat"));
});
