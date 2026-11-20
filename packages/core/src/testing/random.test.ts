import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mulberry32 } from "./random.ts";

describe("mulberry32", () => {
  it("gives the same numbers for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      assert.equal(a(), b());
    }
  });

  it("keeps its known sequence, so recorded seeds keep reproducing", () => {
    const random = mulberry32(1);
    assert.deepEqual(
      [random(), random(), random()].map((n) => Math.floor(n * 1_000_000)),
      [627073, 2735, 527447],
    );
  });

  it("stays in [0, 1)", () => {
    const random = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const n = random();
      assert.ok(n >= 0 && n < 1);
    }
  });
});
