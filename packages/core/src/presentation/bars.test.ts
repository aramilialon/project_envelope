import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CategoryMonth } from "../budget/budget-month.ts";
import { computeCategoryBar, computePaymentCategoryBar, TAIL_PERCENT, TRACK_PERCENT } from "./bars.ts";

function category(overrides: Partial<CategoryMonth> = {}): CategoryMonth {
  return {
    categoryId: "cat-1",
    carriedOver: 0,
    assigned: 0,
    activity: 0,
    available: 0,
    creditOverspending: 0,
    cashOverspending: 0,
    reserved: 0,
    uncovered: 0,
    ...overrides,
  };
}

describe("computeCategoryBar", () => {
  it("an empty category (never assigned, never spent) draws no spent, reserved or tail", () => {
    const bar = computeCategoryBar(category());
    assert.equal(bar.hasBudget, false);
    assert.equal(bar.spentPercent, 0);
    assert.equal(bar.reserved, undefined);
    assert.equal(bar.tail, undefined);
  });

  it("a partial spend is a fraction of the track, with no tail", () => {
    const bar = computeCategoryBar(category({ carriedOver: 0, assigned: 60_000, activity: -30_000, available: 30_000 }));
    assert.equal(bar.hasBudget, true);
    assert.equal(bar.spentPercent, 50);
    assert.equal(bar.tail, undefined);
  });

  it("fully spent fills the whole track, with no tail", () => {
    const bar = computeCategoryBar(category({ assigned: 60_000, activity: -60_000, available: 0 }));
    assert.equal(bar.spentPercent, 100);
    assert.equal(bar.tail, undefined);
  });

  it("cash overspending draws a red tail, sized to the overspent fraction", () => {
    // Assigned 60 000, spent 64 215: 4 215 over a 60 000 budget is 7.025% of it, scaled by the
    // track's own 82% (not the full bar's 100%).
    const bar = computeCategoryBar(
      category({ assigned: 60_000, activity: -64_215, available: -4_215, cashOverspending: 4_215 }),
    );
    assert.equal(bar.spentPercent, 100);
    assert.equal(bar.tail?.kind, "cash");
    assert.ok(bar.tail && Math.abs(bar.tail.widthPercent - (4_215 / 60_000) * TRACK_PERCENT) < 0.01);
  });

  it("credit overspending draws an amber-hatched tail instead", () => {
    const bar = computeCategoryBar(
      category({ assigned: 12_000, activity: -16_850, available: -4_850, creditOverspending: 4_850 }),
    );
    assert.equal(bar.tail?.kind, "credit");
  });

  it("credit wins over cash when a category was overspent on both in the same month", () => {
    const bar = computeCategoryBar(
      category({ assigned: 10_000, activity: -14_000, available: -4_000, cashOverspending: 1_000, creditOverspending: 3_000 }),
    );
    assert.equal(bar.tail?.kind, "credit");
  });

  it("a reservation beyond what is available is a 'short' tail, never cash/credit overspending", () => {
    // Carried 30 000 + assigned 5 000 = 35 000 available before the reservation; reserved 50 000.
    const bar = computeCategoryBar(
      category({ carriedOver: 30_000, assigned: 5_000, activity: 0, available: -15_000, reserved: 50_000 }),
    );
    assert.equal(bar.tail?.kind, "short");
    assert.ok(bar.reserved !== undefined);
  });

  it("a reservation that still fits within the track is drawn, with no tail", () => {
    const bar = computeCategoryBar(category({ assigned: 10_000, activity: 0, available: 10_000, reserved: 4_000 }));
    assert.equal(bar.reserved?.widthPercent, 40);
    assert.equal(bar.tail, undefined);
  });

  it("zero budget but something still spent overflows straight to the tail's own maximum", () => {
    const bar = computeCategoryBar(category({ carriedOver: 0, assigned: 0, activity: -500, available: -500, cashOverspending: 500 }));
    assert.equal(bar.hasBudget, false);
    assert.equal(bar.spentPercent, 0);
    assert.equal(bar.tail?.widthPercent, TAIL_PERCENT);
  });

  it("the tail never exceeds TAIL_PERCENT even far beyond the budget", () => {
    const bar = computeCategoryBar(
      category({ assigned: 1_000, activity: -100_000, available: -99_000, cashOverspending: 99_000 }),
    );
    assert.equal(bar.tail?.widthPercent, TAIL_PERCENT);
  });
});

describe("computePaymentCategoryBar", () => {
  it("no debt at all draws no uncovered segment", () => {
    const bar = computePaymentCategoryBar(category({ uncovered: 0, available: 0 }));
    assert.equal(bar.uncovered, undefined);
  });

  it("fully covered debt (uncovered is 0 despite real debt) draws no uncovered segment", () => {
    const bar = computePaymentCategoryBar(category({ available: 60_000, uncovered: 0 }));
    assert.equal(bar.uncovered, undefined);
  });

  it("partially covered debt draws the uncovered fraction of the card's own real debt", () => {
    // Available 50 000 assigned toward it; uncovered 70 000 means the real debt is 120 000.
    const bar = computePaymentCategoryBar(category({ available: 50_000, uncovered: 70_000 }));
    assert.ok(bar.uncovered);
    assert.equal(bar.uncovered?.leftPercent, (50_000 / 120_000) * 100);
    assert.equal(bar.uncovered?.widthPercent, 100 - (50_000 / 120_000) * 100);
  });

  it("nothing assigned yet against a real debt is fully uncovered", () => {
    const bar = computePaymentCategoryBar(category({ available: 0, uncovered: 120_000 }));
    assert.equal(bar.uncovered?.leftPercent, 0);
    assert.equal(bar.uncovered?.widthPercent, 100);
  });
});
