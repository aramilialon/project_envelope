/**
 * Checks that a function's running time grows linearly with its input, for tests only (#675): a
 * fixed time bound depends on the machine, while the ratio between two input sizes does not. Not
 * part of the domain API (`src/index.ts`).
 */

import assert from "node:assert/strict";

function fastestRun(run: () => void, repeats: number): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

/**
 * Times `run(build(size))` and `run(build(4 * size))`, keeping each one's fastest of a few runs to
 * shed noise, and fails when the larger input takes more than 8 times as long: linear work takes
 * about 4 times as long, quadratic work 16 times (two size doublings; the margin absorbs cache and
 * garbage-collection noise). `size` must be large enough for one run to take a few milliseconds, or
 * timer noise dominates the ratio.
 */
export function assertScalesLinearly<T>(build: (size: number) => T, run: (input: T) => void, size: number): void {
  const small = build(size);
  const large = build(4 * size);
  run(small); // warm-up, so compilation is not counted
  const smallTime = fastestRun(() => run(small), 5);
  const largeTime = fastestRun(() => run(large), 5);
  const ratio = largeTime / Math.max(smallTime, 1);
  assert.ok(
    ratio < 8,
    `an input 4 times as large took ${ratio.toFixed(2)} times as long (${smallTime.toFixed(1)} ms, then ${largeTime.toFixed(1)} ms)`,
  );
}
