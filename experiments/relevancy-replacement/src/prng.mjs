/**
 * Deterministic PRNG (mulberry32), reused wherever this experiment needs
 * reproducible randomness (stratified sampling, calibration subsampling)
 * without a runtime dependency. Same algorithm as src/evaluate.mjs's
 * bootstrapQwkCI so seed=42 means the same sequence everywhere in this repo.
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function rand() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle, in place, using a given rand() -> [0,1) function. Returns the array. */
export function seededShuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
