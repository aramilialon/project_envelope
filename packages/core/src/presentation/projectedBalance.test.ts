import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeProjectedBalance } from "./projectedBalance.ts";

describe("computeProjectedBalance", () => {
  it("is just today's balance when nothing is scheduled", () => {
    assert.equal(computeProjectedBalance(100_000, []), 100_000);
  });

  it("subtracts one overdue scheduled outflow", () => {
    assert.equal(computeProjectedBalance(100_000, [-4_500]), 95_500);
  });

  it("sums several scheduled items spanning the rest of the month, income and outflows alike", () => {
    assert.equal(computeProjectedBalance(100_000, [-4_500, -85_000, 500_000]), 510_500);
  });

  it("can go negative, the same way a real balance can", () => {
    assert.equal(computeProjectedBalance(1_000, [-5_000]), -4_000);
  });
});
