import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ValidationError } from "../errors.ts";
import { computeAccountBalance, isAfterToday } from "./accountBalance.ts";

const TODAY = "2026-11-21";

describe("isAfterToday", () => {
  it("is false for today and earlier, true from tomorrow", () => {
    assert.equal(isAfterToday("2026-11-20", TODAY), false);
    assert.equal(isAfterToday("2026-11-21", TODAY), false);
    assert.equal(isAfterToday("2026-11-22", TODAY), true);
    assert.equal(isAfterToday("2028-03-03", TODAY), true);
  });
});

describe("computeAccountBalance", () => {
  it("is zero for an account with no rows", () => {
    assert.deepEqual(computeAccountBalance([], TODAY), { balanceCents: 0, clearedCents: 0, pendingCents: 0, projectedAtMonthEndCents: 0 });
  });

  it("counts a row dated today and leaves out one dated tomorrow, at the workspace's day boundary", () => {
    const rows = [
      { date: "2026-11-21", amountCents: 10_000, pending: false },
      { date: "2026-11-22", amountCents: 5_000, pending: false },
    ];
    const result = computeAccountBalance(rows, TODAY);
    assert.equal(result.balanceCents, 10_000);
    assert.equal(result.projectedAtMonthEndCents, 15_000);
  });

  it("moves the same rows into today's balance once the workspace's day has turned", () => {
    // 2026-11-30T23:30Z is still 30 November in UTC but already 1 December in Europe/Rome: the
    // caller passes the workspace's own date, and a row dated 1 December then counts.
    const rows = [
      { date: "2026-11-30", amountCents: -2_000, pending: false },
      { date: "2026-12-01", amountCents: 50_000, pending: false },
    ];
    assert.equal(computeAccountBalance(rows, "2026-11-30").balanceCents, -2_000);
    assert.equal(computeAccountBalance(rows, "2026-12-01").balanceCents, 48_000);
  });

  it("splits cleared and pending over the rows up to today only", () => {
    const rows = [
      { date: "2026-11-02", amountCents: 100_000, pending: false },
      { date: "2026-11-20", amountCents: -8_740, pending: true },
      { date: "2026-11-25", amountCents: -4_000, pending: true },
      { date: "2026-12-05", amountCents: 30_000, pending: true },
    ];
    const result = computeAccountBalance(rows, TODAY);
    assert.equal(result.balanceCents, 91_260);
    assert.equal(result.pendingCents, -8_740);
    assert.equal(result.clearedCents, 100_000);
    assert.equal(result.clearedCents + result.pendingCents, result.balanceCents);
  });

  it("projects today's balance plus the rows after today up to the month end, and nothing after it", () => {
    const rows = [
      { date: "2026-11-10", amountCents: 100_000, pending: false },
      { date: "2026-11-30", amountCents: -20_000, pending: true },
      { date: "2026-12-01", amountCents: -30_000, pending: true },
      { date: "2028-03-03", amountCents: 500_000, pending: false },
    ];
    const result = computeAccountBalance(rows, TODAY);
    assert.equal(result.balanceCents, 100_000);
    assert.equal(result.projectedAtMonthEndCents, 80_000);
  });

  it("adds the month's scheduled items not recorded yet, overdue ones of this month included", () => {
    const rows = [{ date: "2026-11-01", amountCents: 100_000, pending: false }];
    const scheduled = [
      { date: "2026-11-15", amountCents: -4_500 }, // overdue
      { date: "2026-11-27", amountCents: 245_000 }, // still to come
    ];
    const result = computeAccountBalance(rows, TODAY, scheduled);
    assert.equal(result.balanceCents, 100_000);
    assert.equal(result.projectedAtMonthEndCents, 340_500);
  });

  it("counts a scheduled item once it is recorded: as its row, not as the item", () => {
    // Recording advances the item's next date out of the month, so only the row remains.
    const recordedForTheFuture = [{ date: "2026-11-27", amountCents: -9_000, pending: true }];
    const nextOccurrence = [{ date: "2026-12-27", amountCents: -9_000 }];
    const result = computeAccountBalance(recordedForTheFuture, TODAY, nextOccurrence);
    assert.equal(result.balanceCents, 0);
    assert.equal(result.projectedAtMonthEndCents, -9_000);
  });

  it("ignores scheduled items dated in another month than today's, earlier or later", () => {
    const scheduled = [
      { date: "2026-10-30", amountCents: -7_000 }, // overdue since last month
      { date: "2026-11-27", amountCents: -1_000 },
      { date: "2026-12-03", amountCents: 50_000 },
    ];
    const result = computeAccountBalance([], TODAY, scheduled);
    assert.equal(result.projectedAtMonthEndCents, -1_000);
  });

  it("keeps a card's negative balance and pushes it further down with a purchase dated after today", () => {
    const card = [
      { date: "2026-11-03", amountCents: -50_000, pending: false },
      { date: "2026-11-28", amountCents: -12_000, pending: true },
    ];
    const result = computeAccountBalance(card, TODAY);
    assert.equal(result.balanceCents, -50_000);
    assert.equal(result.clearedCents, -50_000);
    assert.equal(result.pendingCents, 0);
    assert.equal(result.projectedAtMonthEndCents, -62_000);
  });

  it("leaves the sum of two accounts unchanged by a transfer between them, before and after its date", () => {
    const checking = [
      { date: "2026-11-01", amountCents: 200_000, pending: false },
      { date: "2026-11-25", amountCents: -30_000, pending: true },
    ];
    const savings = [
      { date: "2026-11-01", amountCents: 50_000, pending: false },
      { date: "2026-11-25", amountCents: 30_000, pending: true },
    ];
    for (const today of [TODAY, "2026-11-25", "2026-11-26"]) {
      const a = computeAccountBalance(checking, today);
      const b = computeAccountBalance(savings, today);
      assert.equal(a.balanceCents + b.balanceCents, 250_000, today);
      assert.equal(a.projectedAtMonthEndCents + b.projectedAtMonthEndCents, 250_000, today);
    }
    // Before its date the transfer is in neither balance; from its date on, in both.
    assert.equal(computeAccountBalance(checking, TODAY).balanceCents, 200_000);
    assert.equal(computeAccountBalance(checking, "2026-11-25").balanceCents, 170_000);
  });

  it("counts a reconciled row as cleared: it is not pending", () => {
    // The register maps a reconciled transaction to `pending: false` (`balanceRowOf`).
    const rows = [
      { date: "2026-11-05", amountCents: 40_000, pending: false }, // reconciled
      { date: "2026-11-12", amountCents: -5_000, pending: false }, // cleared
      { date: "2026-11-19", amountCents: -2_000, pending: true },
    ];
    const result = computeAccountBalance(rows, TODAY);
    assert.equal(result.clearedCents, 35_000);
    assert.equal(result.pendingCents, -2_000);
    assert.equal(result.balanceCents, 33_000);
  });

  it("refuses a today that is not a calendar date", () => {
    assert.throws(() => computeAccountBalance([], "2026-11-31"), (error: unknown) => error instanceof ValidationError && error.code === "invalid_date");
  });
});
