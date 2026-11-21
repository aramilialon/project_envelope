import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeBudgetMonth, type Assignment, type BudgetInput, type BudgetMonth, type CategoryMonth } from "../budget/budget-month.ts";
import { mulberry32 } from "../testing/random.ts";
import { cardDebt } from "./cardDebt.ts";
import { amountNeededToCover, computeTodos, type TodoItem } from "./todos.ts";

/**
 * Card debt is asked once, on the card's payment category (#728): the "To do" list never asks
 * for the same money twice, and following every item it lists brings each card's payment
 * category to exactly what the card owes — never more.
 */

const MONTH = "2026-09";

function todosOf(month: BudgetMonth): readonly TodoItem[] {
  return computeTodos({
    unassignedCents: month.unassigned,
    categories: month.categories,
    paymentCategories: month.paymentCategories,
    overdueScheduledItems: [],
    targetsNeeded: [],
  });
}

/** The items that ask for money to cover something: overspending, a reservation shortfall, card debt. */
function coverItems(items: readonly TodoItem[]): readonly (TodoItem & { readonly categoryId: string })[] {
  return items.filter(
    (i): i is TodoItem & { readonly categoryId: string } =>
      i.kind === "cashOverspending" || i.kind === "reservationShortfall" || i.kind === "cardDebtUncovered",
  );
}

function total(items: readonly { readonly amountCents: number }[]): number {
  return items.reduce((sum, i) => sum + i.amountCents, 0);
}

/** Assigns every amount the "To do" list asks for, from unassigned money, in this month. */
function followTodos(input: BudgetInput, month: BudgetMonth): BudgetInput {
  const assignments: Assignment[] = coverItems(todosOf(month)).map((i) => ({ categoryId: i.categoryId, month: MONTH, amount: i.amountCents }));
  return { ...input, assignments: [...input.assignments, ...assignments] };
}

function find(categories: readonly CategoryMonth[], id: string): CategoryMonth {
  const found = categories.find((c) => c.categoryId === id);
  assert.ok(found, `category ${id} missing`);
  return found;
}

/**
 * X2 (#728): Groceries with nothing assigned; the Mastercard added owing €500, €45.67 of
 * groceries on it, €300 paid from checking; the Visa €45.67 of groceries, paid exactly €45.67.
 */
const X2: BudgetInput = {
  categoryIds: ["groceries"],
  paymentCategoryIds: ["mc", "visa"],
  income: [{ month: MONTH, amount: 200_000 }],
  assignments: [],
  activity: [
    { categoryId: "groceries", month: MONTH, amount: -4_567, paymentCategoryId: "mc" },
    { categoryId: "groceries", month: MONTH, amount: -4_567, paymentCategoryId: "visa" },
  ],
  cardPayments: [
    { paymentCategoryId: "mc", month: MONTH, amount: 30_000 },
    { paymentCategoryId: "visa", month: MONTH, amount: 4_567 },
  ],
  cardBalances: [
    { paymentCategoryId: "mc", owed: 50_000 + 4_567 - 30_000, hasStartingBalance: true },
    { paymentCategoryId: "visa", owed: 0, hasStartingBalance: false },
  ],
  today: "2026-09-30",
};

/** V2 (#728): Groceries overspent €50 in cash and €300 on the Visa, nothing assigned. */
const V2: BudgetInput = {
  categoryIds: ["groceries"],
  paymentCategoryIds: ["visa"],
  income: [{ month: MONTH, amount: 200_000 }],
  assignments: [],
  activity: [
    { categoryId: "groceries", month: MONTH, amount: -5_000 },
    { categoryId: "groceries", month: MONTH, amount: -30_000, paymentCategoryId: "visa" },
  ],
  cardPayments: [],
  cardBalances: [{ paymentCategoryId: "visa", owed: 30_000, hasStartingBalance: false }],
  today: "2026-09-30",
};

describe("card debt is asked once, on the card's payment category (#728)", () => {
  it("X2: nothing on Groceries, each card its own to cover, €591.34 in all", () => {
    const month = computeBudgetMonth(X2, MONTH);
    assert.equal(find(month.categories, "groceries").creditOverspending, 9_134);
    assert.deepEqual(coverItems(todosOf(month)), [
      { kind: "cashOverspending", categoryId: "mc", amountCents: 54_567 },
      { kind: "cashOverspending", categoryId: "visa", amountCents: 4_567 },
    ]);
    assert.equal(amountNeededToCover(find(month.categories, "groceries")), 0);
  });

  it("X2: following the list leaves each card holding exactly what it owes, and nothing left to do", () => {
    const after = computeBudgetMonth(followTodos(X2, computeBudgetMonth(X2, MONTH)), MONTH);
    assert.equal(find(after.paymentCategories, "mc").available, 24_567);
    assert.equal(find(after.paymentCategories, "visa").available, 0);
    assert.deepEqual(coverItems(todosOf(after)), []);
  });

  it("X2, the other order: €91.34 assigned to Groceries first gives each card €45.67, and the total is the same", () => {
    const first: BudgetInput = { ...X2, assignments: [{ categoryId: "groceries", month: MONTH, amount: 9_134 }] };
    const month = computeBudgetMonth(first, MONTH);
    assert.deepEqual(coverItems(todosOf(month)), [{ kind: "cashOverspending", categoryId: "mc", amountCents: 50_000 }]);
    assert.equal(9_134 + total(coverItems(todosOf(month))), 59_134);

    const after = computeBudgetMonth(followTodos(first, month), MONTH);
    assert.equal(find(after.paymentCategories, "mc").available, 24_567);
    assert.equal(find(after.paymentCategories, "visa").available, 0);
    assert.deepEqual(coverItems(todosOf(after)), []);
  });

  it("V2: Groceries asks for its €50 of cash, the Visa for its €300, €350 in all", () => {
    const month = computeBudgetMonth(V2, MONTH);
    assert.deepEqual(coverItems(todosOf(month)), [
      { kind: "cashOverspending", categoryId: "groceries", amountCents: 5_000 },
      { kind: "cardDebtUncovered", categoryId: "visa", amountCents: 30_000 },
    ]);

    const after = computeBudgetMonth(followTodos(V2, month), MONTH);
    assert.equal(find(after.paymentCategories, "visa").available, 30_000);
    assert.equal(find(after.categories, "groceries").cashOverspending, 0);
    assert.deepEqual(coverItems(todosOf(after)), []);
  });

  it("V2, the other order: covering the whole €350 on Groceries first moves €300 to the Visa, nothing left to do", () => {
    const first: BudgetInput = { ...V2, assignments: [{ categoryId: "groceries", month: MONTH, amount: 35_000 }] };
    const month = computeBudgetMonth(first, MONTH);
    assert.equal(find(month.paymentCategories, "visa").available, 30_000);
    assert.deepEqual(coverItems(todosOf(month)), []);
  });

  describe("on random months with cards, cash and card spending, payments and reservations", () => {
    const categoryIds = ["groceries", "rent", "fun"];
    const cards = ["visa", "mc"];

    function randomMonth(random: () => number): BudgetInput {
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const amount = (max: number) => Math.floor(random() * max) + 1;
      const activity = Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
        const card = random() < 0.6 ? pick(cards) : undefined;
        return { categoryId: pick(categoryIds), month: MONTH, amount: -amount(40_000), ...(card ? { paymentCategoryId: card } : {}) };
      });
      const assignments = Array.from({ length: Math.floor(random() * 5) }, () => ({ categoryId: pick([...categoryIds, ...cards]), month: MONTH, amount: amount(30_000) }));
      const cardPayments = Array.from({ length: Math.floor(random() * 3) }, () => ({ paymentCategoryId: pick(cards), month: MONTH, amount: amount(60_000) }));
      const scheduledItems = random() < 0.4 ? [{ categoryId: pick(categoryIds), amount: amount(20_000) }] : [];
      // The card's real balance: a starting balance, plus what was spent on it, less what was paid.
      const cardBalances = cards.map((card) => {
        const start = random() < 0.5 ? amount(80_000) : 0;
        const spent = activity.filter((a) => a.paymentCategoryId === card).reduce((sum, a) => sum - a.amount, 0);
        const paid = cardPayments.filter((p) => p.paymentCategoryId === card).reduce((sum, p) => sum + p.amount, 0);
        return { paymentCategoryId: card, owed: start + spent - paid, hasStartingBalance: start > 0 };
      });
      return {
        categoryIds,
        paymentCategoryIds: cards,
        income: [{ month: MONTH, amount: 1_000_000 }],
        assignments,
        activity,
        cardPayments,
        cardBalances,
        scheduledItems,
        today: "2026-09-30",
      };
    }

    it("the list asks each category's own need and each card's to cover once, and following it settles every card", () => {
      const random = mulberry32(728);
      for (let run = 0; run < 500; run++) {
        const input = randomMonth(random);
        const month = computeBudgetMonth(input, MONTH);
        const items = coverItems(todosOf(month));
        const context = `run ${run}: ${JSON.stringify(items)}`;

        // Never two items for the same category.
        assert.equal(new Set(items.map((i) => i.categoryId)).size, items.length, context);

        // The whole list is each ordinary category's own need plus each card's to cover, and
        // nothing else: a category's credit overspending is never asked on the category.
        const categoriesNeed = month.categories.reduce((sum, c) => sum + amountNeededToCover(c), 0);
        const cardsNeed = month.paymentCategories.reduce((sum, c) => sum + cardDebt(c).toCover, 0);
        assert.equal(total(items), categoriesNeed + cardsNeed, context);
        for (const c of month.categories) {
          if (c.reserved === 0) assert.equal(amountNeededToCover(c), c.cashOverspending, context);
        }
        if (month.categories.every((c) => c.reserved === 0)) {
          const cash = month.categories.reduce((sum, c) => sum + c.cashOverspending, 0);
          assert.equal(total(items), cash + cardsNeed, context);
        }

        // Following every item, in one go: each card's payment category holds what it owes (or
        // what it already held beyond that), no category is left overspent in cash, and the list
        // asks for nothing more.
        const after = computeBudgetMonth(followTodos(input, month), MONTH);
        for (const card of month.paymentCategories) {
          const settled = find(after.paymentCategories, card.categoryId);
          assert.equal(settled.available, Math.max(card.available, Math.max(0, card.owed ?? 0)), `${context}, card ${card.categoryId}`);
        }
        for (const c of after.categories) {
          assert.equal(c.cashOverspending, 0, `${context}, category ${c.categoryId}`);
        }
        assert.deepEqual(coverItems(todosOf(after)), [], context);
        assert.equal(after.unassigned, month.unassigned - total(items), context);
      }
    });
  });
});
