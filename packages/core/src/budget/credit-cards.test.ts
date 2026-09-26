import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BudgetInput, CategoryMonth } from "./budget-month.ts";
import { computeBudgetMonth } from "./budget-month.ts";

/** Finds a category in a list, failing the test if it is missing. */
function find(categories: readonly CategoryMonth[], id: string): CategoryMonth {
  const found = categories.find((c) => c.categoryId === id);
  assert.ok(found, `category ${id} missing`);
  return found;
}

const CARD = "card-payment";

/** €1,000 of income in September, one regular category and one credit card. */
function budget(overrides: Partial<BudgetInput>): BudgetInput {
  return {
    categoryIds: ["groceries"],
    paymentCategoryIds: [CARD],
    income: [{ month: "2026-09", amount: 100000 }],
    assignments: [],
    activity: [],
    cardPayments: [],
    ...overrides,
  };
}

describe("credit cards", () => {
  it("covered card spending moves money to the payment category", () => {
    const input = budget({
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 40000 }],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -10000, paymentCategoryId: CARD }],
    });

    const result = computeBudgetMonth(input, "2026-09");

    assert.equal(find(result.categories, "groceries").available, 30000); // 400 − 100
    assert.equal(find(result.paymentCategories, CARD).available, 10000); // set aside to pay the card
    assert.equal(result.unassigned, 60000); // unchanged by the card spending
    assert.equal(result.creditOverspending, 0);
  });

  it("a card payment spends the payment category", () => {
    const input = budget({
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 40000 }],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -10000, paymentCategoryId: CARD }],
      cardPayments: [{ paymentCategoryId: CARD, month: "2026-09", amount: 10000 }],
    });

    const card = find(computeBudgetMonth(input, "2026-09").paymentCategories, CARD);

    assert.equal(card.activity, 0); // +100 moved in, −100 paid
    assert.equal(card.available, 0);
  });

  it("uncovered card spending is credit overspending, which never touches unassigned money", () => {
    const input = budget({
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 5000 }],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -8000, paymentCategoryId: CARD }],
    });

    const september = computeBudgetMonth(input, "2026-09");
    const groceries = find(september.categories, "groceries");
    assert.equal(groceries.available, -3000);
    assert.equal(groceries.creditOverspending, 3000);
    assert.equal(groceries.cashOverspending, 0);
    assert.equal(find(september.paymentCategories, CARD).available, 5000); // only the covered €50
    assert.equal(september.creditOverspending, 3000);

    const october = computeBudgetMonth(input, "2026-10");
    assert.equal(find(october.categories, "groceries").available, 0); // restarts at zero
    assert.equal(october.unassigned, 95000); // 1000 − 50: the €30 became card debt instead
    assert.equal(october.overspentLastMonth, 0);
  });

  it("mixed overspending is attributed to card spending first", () => {
    const input = budget({
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 5000 }],
      activity: [
        { categoryId: "groceries", month: "2026-09", amount: -4000 }, // cash
        { categoryId: "groceries", month: "2026-09", amount: -3000, paymentCategoryId: CARD },
      ],
    });

    const september = computeBudgetMonth(input, "2026-09");
    const groceries = find(september.categories, "groceries");
    assert.equal(groceries.available, -2000);
    assert.equal(groceries.creditOverspending, 2000);
    assert.equal(groceries.cashOverspending, 0);
    assert.equal(find(september.paymentCategories, CARD).available, 1000); // €30 on the card, €20 uncovered

    const moreCash = budget({
      ...input,
      activity: [
        { categoryId: "groceries", month: "2026-09", amount: -6000 },
        { categoryId: "groceries", month: "2026-09", amount: -3000, paymentCategoryId: CARD },
      ],
    });
    const mixed = find(computeBudgetMonth(moreCash, "2026-09").categories, "groceries");
    assert.equal(mixed.creditOverspending, 3000); // all the card spending
    assert.equal(mixed.cashOverspending, 1000); // the rest
    assert.equal(computeBudgetMonth(moreCash, "2026-10").overspentLastMonth, 1000);
  });

  it("assigning money later in the month also funds earlier card spending", () => {
    const input = budget({
      assignments: [
        { categoryId: "groceries", month: "2026-09", amount: 5000 },
        { categoryId: "groceries", month: "2026-09", amount: 3000 }, // added after the purchase
      ],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -8000, paymentCategoryId: CARD }],
    });

    const september = computeBudgetMonth(input, "2026-09");

    assert.equal(find(september.categories, "groceries").available, 0);
    assert.equal(find(september.paymentCategories, CARD).available, 8000);
    assert.equal(september.creditOverspending, 0);
  });

  it("a refund on the card moves the money back to the category", () => {
    const input = budget({
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 40000 }],
      activity: [
        { categoryId: "groceries", month: "2026-09", amount: -10000, paymentCategoryId: CARD },
        { categoryId: "groceries", month: "2026-10", amount: 2500, paymentCategoryId: CARD },
      ],
    });

    const october = computeBudgetMonth(input, "2026-10");

    assert.equal(find(october.categories, "groceries").available, 32500); // 300 carried + 25 refund
    assert.equal(find(october.paymentCategories, CARD).available, 7500); // 100 − 25
  });

  it("money can be assigned to a payment category to pay existing debt", () => {
    const input = budget({
      assignments: [{ categoryId: CARD, month: "2026-09", amount: 20000 }],
      cardPayments: [{ paymentCategoryId: CARD, month: "2026-09", amount: 20000 }],
    });

    const result = computeBudgetMonth(input, "2026-09");

    assert.equal(find(result.paymentCategories, CARD).available, 0);
    assert.equal(result.unassigned, 80000);
  });

  it("paying more than the payment category holds is cash overspending", () => {
    const input = budget({
      cardPayments: [{ paymentCategoryId: CARD, month: "2026-09", amount: 5000 }],
    });

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(find(september.paymentCategories, CARD).cashOverspending, 5000);
    assert.equal(computeBudgetMonth(input, "2026-10").unassigned, 95000);
  });
});
