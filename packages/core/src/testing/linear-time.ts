/**
 * Checks that a function's running time grows linearly with its input, for tests only (#675): a
 * fixed time bound depends on the machine, while the ratio between two input sizes does not. Not
 * part of the domain API (`src/index.ts`).
 */

import assert from "node:assert/strict";

/** How much larger each input is than the one before. */
const STEP = 8;
/** The largest growth in time accepted from one input to the next: linear work grows about 8-fold, quadratic work 64-fold. */
const LIMIT = 32;
/** Times below this many milliseconds are counted as this much, so timer resolution does not make a ratio. */
const FLOOR = 1;
/** How many times each input is run; the fastest run counts. */
const REPEATS = 3;

/** The process's CPU time (user and system) spent on `run`, in milliseconds. */
function cpuTime(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** The fastest of up to `REPEATS` runs, stopping at the first one within `bound`. */
function fastestRun(run: () => void, bound: number): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < REPEATS && fastest > bound; i++) fastest = Math.min(fastest, cpuTime(run));
  return fastest;
}

/**
 * Times `run(build(n))` for n = size / 64, size / 8, size and 8 * size, and fails as soon as one
 * input takes more than 32 times as long as the one before it: linear work takes about 8 times as
 * long, quadratic work 64 times, and the margin absorbs cache and garbage-collection noise.
 *
 * - Each time is the process's CPU time (user and system), not wall-clock time, so other processes
 *   competing for the machine do not count; the fastest of a few runs is kept to shed what noise
 *   remains, and a time under 1 ms counts as 1 ms.
 * - The inputs grow from small ones, so a quadratic regression fails at the first size where its
 *   growth shows, within seconds, instead of running for hours on the largest input: a synchronous
 *   test cannot be stopped by a `node:test` timeout.
 * - `size` should make one run take a few milliseconds; a function that returns at once on every
 *   input (an input it gives up on early) passes, and the check then only guards against growth.
 */
export function assertScalesLinearly<T>(build: (size: number) => T, run: (input: T) => void, size: number): void {
  const sizes = [size / (STEP * STEP), size / STEP, size, size * STEP].map((n) => Math.max(1, Math.round(n)));
  let previous: { readonly size: number; readonly time: number } | undefined;
  for (const n of sizes) {
    const input = build(n);
    if (previous === undefined) {
      run(input); // warm-up, so compilation is not counted
      previous = { size: n, time: fastestRun(() => run(input), 0) };
      continue;
    }
    const time = fastestRun(() => run(input), LIMIT * Math.max(previous.time, FLOOR));
    const ratio = time / Math.max(previous.time, FLOOR);
    assert.ok(
      ratio < LIMIT,
      `an input ${STEP} times as large (${n} instead of ${previous.size}) took ${ratio.toFixed(2)} times as long (${previous.time.toFixed(1)} ms, then ${time.toFixed(1)} ms of CPU time)`,
    );
    previous = { size: n, time };
  }
}
