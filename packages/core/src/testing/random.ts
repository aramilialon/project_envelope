/**
 * Pseudo-random numbers with a fixed seed, for tests only: the same seed gives the same numbers
 * on every run and every machine, so a failing randomized test can always be reproduced. Not part
 * of the domain API (`src/index.ts`); `apps/api` imports it as `@envelope/core/testing`.
 */

/**
 * mulberry32: a small 32-bit generator, good enough to spread test data, never for anything
 * secret. Returns a function giving numbers in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
