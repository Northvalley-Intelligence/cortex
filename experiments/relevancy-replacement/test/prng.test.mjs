import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, seededShuffle } from "../src/prng.mjs";

test("mulberry32 is deterministic for a given seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test("mulberry32 yields values in [0,1)", () => {
  const rand = mulberry32(1);
  for (let i = 0; i < 1000; i++) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
  }
});

test("seededShuffle is deterministic and a permutation (same elements, same length)", () => {
  const arr1 = seededShuffle([1, 2, 3, 4, 5], mulberry32(7));
  const arr2 = seededShuffle([1, 2, 3, 4, 5], mulberry32(7));
  assert.deepEqual(arr1, arr2);
  assert.deepEqual([...arr1].sort(), [1, 2, 3, 4, 5]);
});
