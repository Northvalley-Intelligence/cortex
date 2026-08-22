import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.mjs";
import { buildCorpusIndex, scoreBm25 } from "../src/bm25.mjs";

test("tokenize lowercases and splits on non-alphanumerics", () => {
  assert.deepEqual(tokenize("Waterproof Rain-Jacket, Women's!"), ["waterproof", "rain", "jacket", "women", "s"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});

test("buildCorpusIndex dedupes titles for document frequency", () => {
  const titles = ["red shoes", "red shoes", "blue socks"];
  const index = buildCorpusIndex(titles);
  assert.equal(index.N, 2, "duplicate title counted once as a document");
  // "red" appears in 1 of 2 distinct docs, "blue" in 1 of 2 distinct docs -- same df, same idf
  assert.ok(Math.abs(index.idf.red - index.idf.blue) < 1e-9);
});

test("scoreBm25 scores an exact lexical match higher than an unrelated title", () => {
  const titles = [
    "waterproof hiking boots for men",
    "cotton crew neck t-shirt",
    "leather dress shoes",
    "running shoes for women",
    "winter waterproof jacket",
  ];
  const index = buildCorpusIndex(titles);
  const relevant = scoreBm25("waterproof hiking boots", "waterproof hiking boots for men", index);
  const irrelevant = scoreBm25("waterproof hiking boots", "cotton crew neck t-shirt", index);
  assert.ok(relevant > irrelevant, `expected relevant score (${relevant}) > irrelevant score (${irrelevant})`);
});

test("scoreBm25 is 0 when the query and title share no terms", () => {
  const titles = ["red shoes", "blue socks", "green hat"];
  const index = buildCorpusIndex(titles);
  assert.equal(scoreBm25("purple gloves", "red shoes", index), 0);
});

test("scoreBm25 handles a query term never seen in the corpus without throwing", () => {
  const titles = ["red shoes", "blue socks"];
  const index = buildCorpusIndex(titles);
  const score = scoreBm25("xyzzyunseenterm", "red shoes", index);
  assert.equal(score, 0); // term not present in this particular title -> 0 contribution regardless of idf
});
