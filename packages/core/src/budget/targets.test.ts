import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeTarget, type CategoryTargetState, type Target } from "./targets.ts";

const ZERO: CategoryTargetState = { carried: 0, assigned: 0, available: 0 };

describe("computeTarget", () => {
  describe("monthly amount", () => {
    const target: Target = { kind: "monthly", amount: 60000 };

    it("asks the amount, missing is what is not yet assigned, progress is assigned/amount", () => {
      const result = computeTarget(target, { ...ZERO, assigned: 40000 }, "2026-09");
      assert.equal(result.asks, 60000);
      assert.equal(result.missing, 20000);
      assert.equal(result.progress, 40000 / 60000);
    });

    it("missing never goes negative once fully assigned", () => {
      const result = computeTarget(target, { ...ZERO, assigned: 90000 }, "2026-09");
      assert.equal(result.missing, 0);
    });
  });

  describe("amount by a date", () => {
    it("matches design.md's own worked example", () => {
      // €3,600 for holidays by June 2027, €1,250 carried into September 2026, €200 assigned.
      const target: Target = { kind: "by_date", amount: 360_000, dueMonth: "2027-06" };
      const result = computeTarget(target, { carried: 125_000, assigned: 20_000, available: 145_000 }, "2026-09");
      assert.equal(result.asks, 23_500); // (360000 - 125000) / 10 months, rounded up to the cent
      assert.equal(result.missing, 3_500); // 23500 - 20000
    });

    it("progress is available divided by the total", () => {
      const target: Target = { kind: "by_date", amount: 100000, dueMonth: "2027-03" };
      const result = computeTarget(target, { ...ZERO, available: 25000 }, "2026-09");
      assert.equal(result.progress, 0.25);
    });

    it("an overdue due month still asks for the rest in one go, not a division by zero", () => {
      const target: Target = { kind: "by_date", amount: 10000, dueMonth: "2026-08" };
      const result = computeTarget(target, { ...ZERO, carried: 4000 }, "2026-09");
      assert.equal(result.asks, 6000); // (10000 - 4000) / max(1, 0)
    });
  });

  describe("repeating expense", () => {
    it("behaves like 'amount by a date' before the due month", () => {
      const target: Target = { kind: "repeating", amount: 60000, every: 6, dueMonth: "2026-12" };
      const result = computeTarget(target, { ...ZERO, carried: 0 }, "2026-09");
      assert.equal(result.asks, 15000); // 60000 / 4 months (Sep..Dec)
    });

    it("rolls the due month forward by the interval once it is in the past", () => {
      const target: Target = { kind: "repeating", amount: 60000, every: 6, dueMonth: "2026-06" };
      // Due in June, asked in September (3 months late): next due month is December.
      const result = computeTarget(target, ZERO, "2026-09");
      assert.equal(result.asks, 15000); // 60000 / 4 months (Sep..Dec), same as an explicit December due month
    });

    it("rolls forward by more than one interval when several have passed", () => {
      const target: Target = { kind: "repeating", amount: 12000, every: 3, dueMonth: "2026-01" };
      // Due months would be Jan, Apr, Jul, Oct... asked in September, the next one is October.
      const result = computeTarget(target, ZERO, "2026-09");
      assert.equal(result.asks, 6000); // 12000 / 2 months (Sep..Oct)
    });
  });

  describe("balance to keep", () => {
    const target: Target = { kind: "balance", threshold: 500000 };

    it("asks the threshold minus what is already available", () => {
      const result = computeTarget(target, { ...ZERO, available: 300000 }, "2026-09");
      assert.equal(result.asks, 200000);
      assert.equal(result.missing, 200000); // the same, per design.md
      assert.equal(result.progress, 300000 / 500000);
    });

    it("asks nothing once the threshold is already held", () => {
      const result = computeTarget(target, { ...ZERO, available: 600000 }, "2026-09");
      assert.equal(result.asks, 0);
      assert.equal(result.missing, 0);
    });
  });
});
