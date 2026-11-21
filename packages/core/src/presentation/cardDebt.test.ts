import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeBudgetMonth } from "../budget/budget-month.ts";
import { cardDebt } from "./cardDebt.ts";
import { amountNeededToCover, computeTodos } from "./todos.ts";

describe("cardDebt", () => {
  it("no debt and nothing set aside: all zero", () => {
    assert.deepEqual(cardDebt({ available: 0, uncovered: 0, owed: 0 }), {
      owed: 0,
      setAside: 0,
      paidBeyondSetAside: 0,
      uncovered: 0,
      toCover: 0,
    });
  });

  it("partially covered: set aside is available, to cover is what it does not cover", () => {
    assert.deepEqual(cardDebt({ available: 50_000, uncovered: 70_000, owed: 120_000 }), {
      owed: 120_000,
      setAside: 50_000,
      paidBeyondSetAside: 0,
      uncovered: 70_000,
      toCover: 70_000,
    });
  });

  it("more set aside than owed: nothing to cover", () => {
    const debt = cardDebt({ available: 80_000, uncovered: 0, owed: 60_000 });
    assert.equal(debt.setAside, 80_000);
    assert.equal(debt.toCover, 0);
  });

  it("an unknown card balance counts as owing nothing", () => {
    assert.equal(cardDebt({ available: 0, uncovered: 0 }).owed, 0);
  });

  it("a card in credit (negative owed) still needs its cash overspending covered", () => {
    const debt = cardDebt({ available: -5_000, uncovered: 0, owed: -1_000 });
    assert.equal(debt.paidBeyondSetAside, 5_000);
    assert.equal(debt.toCover, 5_000);
  });

  it("the domain guide's worked example: paid beyond what was set aside (#699)", () => {
    // Card opened owing €500, €45.67 of groceries on it (covered by Groceries), €300 paid from
    // checking, nothing assigned to the payment category.
    const CARD = "visa-payment";
    const month = computeBudgetMonth(
      {
        categoryIds: ["groceries"],
        paymentCategoryIds: [CARD],
        income: [{ month: "2026-09", amount: 100_000 }],
        assignments: [{ categoryId: "groceries", month: "2026-09", amount: 10_000 }],
        activity: [{ categoryId: "groceries", month: "2026-09", amount: -4_567, paymentCategoryId: CARD }],
        cardPayments: [{ paymentCategoryId: CARD, month: "2026-09", amount: 30_000 }],
        cardBalances: [{ paymentCategoryId: CARD, owed: 50_000 + 4_567 - 30_000, hasStartingBalance: true }],
        today: "2026-09-30",
      },
      "2026-09",
    );
    const card = month.paymentCategories.find((c) => c.categoryId === CARD);
    assert.ok(card);

    assert.deepEqual(cardDebt(card), {
      owed: 24_567, // the debt shown
      setAside: 0, // never negative
      paidBeyondSetAside: 25_433, // "Paid beyond what was set aside: €254.33"
      uncovered: 24_567,
      toCover: 50_000, // €254.33 of cash overspending + €245.67 still uncovered
    });
    assert.equal(cardDebt(card).toCover, card.cashOverspending + card.uncovered);

    // The "To do" item and "Assign" both ask for the same €500.00, as one item.
    assert.equal(amountNeededToCover(card), 50_000);
    const todos = computeTodos({
      unassignedCents: month.unassigned,
      categories: month.categories,
      paymentCategories: month.paymentCategories,
      overdueScheduledItems: [],
      targetsNeeded: [],
    });
    assert.deepEqual(
      todos.filter((t) => "categoryId" in t && t.categoryId === CARD),
      [{ kind: "cashOverspending", categoryId: CARD, amountCents: 50_000 }],
    );
  });
});
