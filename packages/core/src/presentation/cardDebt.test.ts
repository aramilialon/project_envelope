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

  describe("over every sign of owed and available (#699)", () => {
    const CARD = "card-payment";
    // Each case sets the card's real balance (`owed`, absent when no balance is known) and brings
    // the payment category's available to the given sign with an assignment or a card payment.
    const cases: readonly { name: string; owed: number | undefined; assign: number; pay: number }[] = [
      { name: "owed > 0, 0 <= available < owed", owed: 100_000, assign: 40_000, pay: 0 },
      { name: "owed > 0, available = 0", owed: 100_000, assign: 0, pay: 0 },
      { name: "owed > 0, available >= owed", owed: 100_000, assign: 150_000, pay: 0 },
      { name: "owed > 0, available < 0", owed: 100_000, assign: 0, pay: 30_000 },
      { name: "owed = 0, available < 0", owed: 0, assign: 0, pay: 30_000 },
      { name: "owed < 0 (in credit), available < 0", owed: -1_000, assign: 0, pay: 5_000 },
      { name: "owed < 0 (in credit), available >= 0", owed: -1_000, assign: 10_000, pay: 0 },
      { name: "owed absent, available < 0", owed: undefined, assign: 0, pay: 30_000 },
      { name: "owed absent, available >= 0", owed: undefined, assign: 10_000, pay: 0 },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const month = computeBudgetMonth(
          {
            categoryIds: [],
            paymentCategoryIds: [CARD],
            income: [{ month: "2026-09", amount: 1_000_000 }],
            assignments: c.assign > 0 ? [{ categoryId: CARD, month: "2026-09", amount: c.assign }] : [],
            activity: [],
            cardPayments: c.pay > 0 ? [{ paymentCategoryId: CARD, month: "2026-09", amount: c.pay }] : [],
            cardBalances: c.owed === undefined ? [] : [{ paymentCategoryId: CARD, owed: c.owed, hasStartingBalance: false }],
            today: "2026-09-30",
          },
          "2026-09",
        );
        const card = month.paymentCategories.find((p) => p.categoryId === CARD);
        assert.ok(card);
        assert.equal(card.available, c.assign - c.pay);
        const debt = cardDebt(card);

        assert.equal(debt.toCover, card.cashOverspending + card.uncovered);
        assert.equal(debt.toCover, Math.max(0, Math.max(0, c.owed ?? 0) - card.available));
        assert.equal(debt.paidBeyondSetAside, card.cashOverspending);
        assert.ok(debt.setAside >= 0);
        assert.equal(amountNeededToCover(card), debt.toCover);

        const items = computeTodos({
          unassignedCents: month.unassigned,
          categories: month.categories,
          paymentCategories: month.paymentCategories,
          overdueScheduledItems: [],
          targetsNeeded: [],
        }).filter((t) => "categoryId" in t && t.categoryId === CARD);
        assert.ok(items.length <= 1, `never two To do items for one payment category: ${JSON.stringify(items)}`);
        if (debt.toCover > 0) {
          assert.equal(items.length, 1);
          assert.equal(items[0] && "amountCents" in items[0] ? items[0].amountCents : undefined, debt.toCover);
        } else {
          assert.equal(items.length, 0);
        }
      });
    }
  });
});
