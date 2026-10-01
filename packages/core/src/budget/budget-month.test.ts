import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { BudgetInput, CategoryMonth } from "./budget-month.ts";
import { computeBudgetMonth } from "./budget-month.ts";

/** Finds a category in the result, failing the test if it is missing. */
function category(categories: readonly CategoryMonth[], id: string): CategoryMonth {
  const found = categories.find((c) => c.categoryId === id);
  assert.ok(found, `category ${id} missing`);
  return found;
}

const EMPTY: BudgetInput = { categoryIds: [], income: [], assignments: [], activity: [] };

describe("computeBudgetMonth", () => {
  it("only money that has arrived can be assigned", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries", "rent"],
      income: [{ month: "2026-09", amount: 200000 }],
      assignments: [
        { categoryId: "groceries", month: "2026-09", amount: 40000 },
        { categoryId: "rent", month: "2026-09", amount: 90000 },
      ],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -35000 }],
    };

    const result = computeBudgetMonth(input, "2026-09");

    assert.equal(result.unassigned, 70000); // 2000 − 400 − 900 = €700
    assert.equal(category(result.categories, "groceries").available, 5000); // 400 − 350 = €50
    assert.equal(category(result.categories, "rent").available, 90000);
  });

  it("a positive available balance rolls over to the next month", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries"],
      income: [{ month: "2026-09", amount: 100000 }],
      assignments: [
        { categoryId: "groceries", month: "2026-09", amount: 40000 },
        { categoryId: "groceries", month: "2026-10", amount: 40000 },
      ],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -35000 }],
    };

    const october = category(computeBudgetMonth(input, "2026-10").categories, "groceries");

    assert.equal(october.carriedOver, 5000);
    assert.equal(october.available, 45000);
  });

  it("overspending left at the end of a month is taken from unassigned money the next month", () => {
    const input: BudgetInput = {
      categoryIds: ["fun"],
      income: [{ month: "2026-09", amount: 50000 }],
      assignments: [{ categoryId: "fun", month: "2026-09", amount: 10000 }],
      activity: [{ categoryId: "fun", month: "2026-09", amount: -15000 }],
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(category(september.categories, "fun").available, -5000); // overspent by €50
    assert.equal(september.unassigned, 40000); // nothing changes yet within the month

    const october = computeBudgetMonth(input, "2026-10");
    assert.equal(category(october.categories, "fun").available, 0); // restarts at zero
    assert.equal(october.overspentLastMonth, 5000);
    assert.equal(october.unassigned, 35000); // 500 − 100 − 50 = €350
  });

  it("a scheduled item not yet recorded reserves its amount, net from available", () => {
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [{ month: "2026-09", amount: 100000 }],
      assignments: [{ categoryId: "rent", month: "2026-09", amount: 90000 }],
      activity: [],
      scheduledItems: [{ categoryId: "rent", amount: 90000 }],
    };

    const result = computeBudgetMonth(input, "2026-09");

    const rent = category(result.categories, "rent");
    assert.equal(rent.reserved, 90000);
    assert.equal(rent.available, 0); // 900 assigned − 900 reserved
    assert.equal(result.reserved, 90000);
  });

  it("a reservation beyond what a category can cover is a warning, not overspending", () => {
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [{ month: "2026-09", amount: 50000 }],
      assignments: [{ categoryId: "rent", month: "2026-09", amount: 50000 }],
      activity: [],
      scheduledItems: [{ categoryId: "rent", amount: 80000 }],
    };

    const result = computeBudgetMonth(input, "2026-09");

    const rent = category(result.categories, "rent");
    assert.equal(rent.available, -30000); // reservation exceeds what is assigned
    assert.equal(rent.cashOverspending, 0, "a reservation shortfall must never count as overspending");
    assert.equal(rent.creditOverspending, 0);
    assert.equal(result.overspentLastMonth, 0);
  });

  it("reservations do not carry over: a fresh month starts with none of the last one's shortfall", () => {
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [
        { month: "2026-09", amount: 50000 },
        { month: "2026-10", amount: 50000 },
      ],
      assignments: [
        { categoryId: "rent", month: "2026-09", amount: 50000 },
        { categoryId: "rent", month: "2026-10", amount: 50000 },
      ],
      activity: [],
      // Only ever reserves against the month actually requested (no month field of its own).
      scheduledItems: [{ categoryId: "rent", amount: 80000 }],
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(category(september.categories, "rent").available, -30000);

    const october = computeBudgetMonth(input, "2026-10");
    // September's reservation shortfall never counted as real overspending (the previous test),
    // so it neither zeroed carriedOver nor reduced it: October's own carriedOver is September's
    // full, un-reserved 50000, on top of which October assigns another 50000 and reapplies the
    // very same still-outstanding item — 100000 now comfortably covers the 80000 reservation,
    // unaffected by September ever having fallen short of it.
    assert.equal(category(october.categories, "rent").carriedOver, 50000);
    assert.equal(category(october.categories, "rent").available, 20000);
    assert.equal(october.overspentLastMonth, 0);
  });

  it("money assigned to future months reduces unassigned money immediately", () => {
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [{ month: "2026-09", amount: 100000 }],
      assignments: [{ categoryId: "rent", month: "2026-10", amount: 90000 }],
      activity: [],
    };

    const september = computeBudgetMonth(input, "2026-09");

    assert.equal(september.unassigned, 10000);
    assert.equal(september.assignedInFuture, 90000);
  });

  it("income dated in future months cannot be assigned yet", () => {
    const input: BudgetInput = {
      ...EMPTY,
      income: [
        { month: "2026-09", amount: 100000 },
        { month: "2026-10", amount: 200000 },
      ],
    };

    assert.equal(computeBudgetMonth(input, "2026-09").unassigned, 100000);
    assert.equal(computeBudgetMonth(input, "2026-10").unassigned, 300000);
  });

  it("assigning more than is available takes unassigned money below zero", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries"],
      income: [{ month: "2026-09", amount: 10000 }],
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 15000 }],
      activity: [],
    };

    assert.equal(computeBudgetMonth(input, "2026-09").unassigned, -5000);
  });

  it("a credit-to-credit transfer moves what the source payment category holds, into the destination's", () => {
    const input: BudgetInput = {
      ...EMPTY,
      paymentCategoryIds: ["a-payment", "b-payment"],
      assignments: [{ categoryId: "a-payment", month: "2026-09", amount: 50000 }],
      cardTransfers: [
        { sourcePaymentCategoryId: "a-payment", destinationPaymentCategoryId: "b-payment", month: "2026-09", amount: 50000 },
      ],
    };

    const result = computeBudgetMonth(input, "2026-09");

    assert.equal(category(result.paymentCategories, "a-payment").available, 0);
    assert.equal(category(result.paymentCategories, "b-payment").available, 50000);
  });

  it("a transfer beyond what the source holds moves only what it has, never as cash overspending", () => {
    const input: BudgetInput = {
      ...EMPTY,
      paymentCategoryIds: ["a-payment", "b-payment"],
      assignments: [{ categoryId: "a-payment", month: "2026-09", amount: 30000 }],
      cardTransfers: [
        { sourcePaymentCategoryId: "a-payment", destinationPaymentCategoryId: "b-payment", month: "2026-09", amount: 50000 },
      ],
    };

    const result = computeBudgetMonth(input, "2026-09");

    const a = category(result.paymentCategories, "a-payment");
    assert.equal(a.available, 0, "the source never goes negative from a transfer it cannot fully cover");
    assert.equal(a.cashOverspending, 0, "an uncovered transfer is never cash overspending: nothing real moved");
    assert.equal(category(result.paymentCategories, "b-payment").available, 30000);
  });

  it("rejects invalid data with a translatable error code", () => {
    assert.throws(
      () => computeBudgetMonth(EMPTY, "2026-13"),
      (error) => isValidationError(error, "invalid_month"),
    );
    assert.throws(
      () => computeBudgetMonth({ ...EMPTY, categoryIds: ["a", "a"] }, "2026-09"),
      (error) => isValidationError(error, "duplicate_category"),
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          { ...EMPTY, assignments: [{ categoryId: "missing", month: "2026-09", amount: 100 }] },
          "2026-09",
        ),
      (error) => isValidationError(error, "unknown_category") && error.details["categoryId"] === "missing",
    );
    assert.throws(
      () => computeBudgetMonth({ ...EMPTY, income: [{ month: "2026-09", amount: 10.5 }] }, "2026-09"),
      (error) => isValidationError(error, "invalid_amount"),
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          {
            ...EMPTY,
            paymentCategoryIds: ["a-payment"],
            cardTransfers: [
              { sourcePaymentCategoryId: "a-payment", destinationPaymentCategoryId: "missing", month: "2026-09", amount: 100 },
            ],
          },
          "2026-09",
        ),
      (error) => isValidationError(error, "unknown_category") && error.details["categoryId"] === "missing",
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          {
            ...EMPTY,
            paymentCategoryIds: ["a-payment", "b-payment"],
            cardTransfers: [
              { sourcePaymentCategoryId: "a-payment", destinationPaymentCategoryId: "b-payment", month: "2026-09", amount: 0 },
            ],
          },
          "2026-09",
        ),
      (error) => isValidationError(error, "invalid_amount"),
    );
  });
});

/**
 * Pseudo-random number generator with a fixed seed (mulberry32): the same
 * numbers on every run, so a failing test can always be reproduced.
 */
function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("budget invariant", () => {
  // Whatever happens, the books must balance:
  //   unassigned money + available of the month + assigned in future
  //   = income so far + activity so far (that is, the account balance)
  it("balances on 500 random budgets", () => {
    const random = randomGenerator(42);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
    const categoryIds = ["groceries", "rent", "fun", "car"];
    const amount = () => Math.floor(random() * 200000) - 50000; // from −€500 to +€1,500

    for (let run = 0; run < 500; run++) {
      const input: BudgetInput = {
        categoryIds,
        income: Array.from({ length: 5 }, () => ({ month: pick(months), amount: Math.abs(amount()) })),
        assignments: Array.from({ length: 15 }, () => ({
          categoryId: pick(categoryIds),
          month: pick(months),
          amount: amount(),
        })),
        activity: Array.from({ length: 20 }, () => ({
          categoryId: pick(categoryIds),
          month: pick(months),
          amount: -Math.abs(amount()),
        })),
      };
      const month = pick(months);

      const result = computeBudgetMonth(input, month);

      const availableTotal = result.categories.reduce((sum, c) => sum + c.available, 0);
      const incomeSoFar = input.income.filter((i) => i.month <= month).reduce((sum, i) => sum + i.amount, 0);
      const activitySoFar = input.activity.filter((a) => a.month <= month).reduce((sum, a) => sum + a.amount, 0);

      assert.equal(
        result.unassigned + availableTotal + result.assignedInFuture,
        incomeSoFar + activitySoFar,
        `invariant violated on run ${run}, month ${month}`,
      );
    }
  });
});
