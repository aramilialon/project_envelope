import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeBudgetMonth, type Assignment, type BudgetInput, type BudgetMonth, type CategoryMonth } from "../budget/budget-month.ts";
import { owing } from "../testing/card-balance.ts";
import { mulberry32 } from "../testing/random.ts";
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

/**
 * The items that ask for money to cover something: every item tied to one category except an
 * overdue scheduled transaction (which asks to record it, not to assign). Filtered by exclusion,
 * so that an item kind added later for a category is followed here too.
 */
function coverItems(items: readonly TodoItem[]): readonly (TodoItem & { readonly categoryId: string })[] {
  return items.filter(
    (i): i is TodoItem & { readonly categoryId: string } => "categoryId" in i && i.kind !== "scheduledOverdue",
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
    { paymentCategoryId: "mc", transactions: owing(50_000 + 4_567 - 30_000, `${MONTH}-01`), hasStartingBalance: true },
    { paymentCategoryId: "visa", transactions: owing(0, `${MONTH}-01`), hasStartingBalance: false },
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
  cardBalances: [{ paymentCategoryId: "visa", transactions: owing(30_000, `${MONTH}-01`), hasStartingBalance: false }],
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

  describe("on random months with cards, cash and card spending, refunds, payments, card-to-card transfers and reservations", () => {
    const categoryIds = ["groceries", "rent", "fun"];
    const cards = ["visa", "mc"];

    function randomMonth(random: () => number): BudgetInput {
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const amount = (max: number) => Math.floor(random() * max) + 1;
      const activity = Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
        const card = random() < 0.6 ? pick(cards) : undefined;
        // One in six is a refund (positive), on a card or in cash.
        const sign = random() < 1 / 6 ? 1 : -1;
        return { categoryId: pick(categoryIds), month: MONTH, amount: sign * amount(40_000), ...(card ? { paymentCategoryId: card } : {}) };
      });
      const assignments = Array.from({ length: Math.floor(random() * 5) }, () => ({ categoryId: pick([...categoryIds, ...cards]), month: MONTH, amount: amount(30_000) }));
      const cardPayments = Array.from({ length: Math.floor(random() * 3) }, () => ({ paymentCategoryId: pick(cards), month: MONTH, amount: amount(60_000) }));
      // Up to two card-to-card transfers, either way: one card pays part of the other's debt, so
      // it is charged and the other is paid (#732). Large enough that many move less than their
      // amount (the paid card holds less than it still owes).
      const cardTransfers = Array.from({ length: random() < 0.4 ? 1 + Math.floor(random() * 2) : 0 }, (_, i) => {
        const charged = pick(cards);
        const paid = charged === "visa" ? "mc" : "visa";
        const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
        return { paidPaymentCategoryId: paid, chargedPaymentCategoryId: charged, month: MONTH, date: `${MONTH}-${day}`, id: `t${i}`, amount: amount(40_000) };
      });
      const scheduledItems = random() < 0.4 ? [{ categoryId: pick(categoryIds), amount: amount(20_000) }] : [];
      // The card's real balance: a starting balance (or a card in credit), plus what was spent on
      // it, less what was paid, plus what it was charged by a transfer to the other card.
      const cardBalances = cards.map((card) => {
        const roll = random();
        const start = roll < 0.4 ? amount(80_000) : roll < 0.55 ? -amount(20_000) : 0;
        const spent = activity.filter((a) => a.paymentCategoryId === card).reduce((sum, a) => sum - a.amount, 0);
        const paid = cardPayments.filter((p) => p.paymentCategoryId === card).reduce((sum, p) => sum + p.amount, 0);
        const transferred = cardTransfers.reduce(
          (sum, t) => sum + (t.chargedPaymentCategoryId === card ? t.amount : 0) - (t.paidPaymentCategoryId === card ? t.amount : 0),
          0,
        );
        return { paymentCategoryId: card, transactions: owing(start + spent - paid + transferred, `${MONTH}-01`), hasStartingBalance: start > 0 };
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
        cardTransfers,
        today: "2026-09-30",
      };
    }

    /** What a category's reservation is short by, written out again rather than read from `todos.ts`. */
    function shortfall(c: CategoryMonth): number {
      if (c.reserved <= 0) return 0;
      return Math.min(c.reserved, Math.max(0, c.reserved - Math.max(0, c.available + c.reserved)));
    }

    /** What a card takes to cover, written out again rather than read from `cardDebt`: owed is signed (#660). */
    function toCover(c: CategoryMonth): number {
      return Math.max(0, (c.owed ?? 0) - c.available);
    }

    /** The card spending a category asks together with its reservation shortfall (#731), written out again. */
    function cardSpendingAsked(c: CategoryMonth): number {
      return c.creditOverspending > 0 && shortfall(c) > 0 ? c.creditOverspending : 0;
    }

    /** What is asked on ordinary categories instead of on `card` (#731), from its `overspendingBy`. */
    function askedOnCategoriesFor(month: BudgetMonth, card: CategoryMonth): number {
      return (card.overspendingBy ?? [])
        .filter((p) => cardSpendingAsked(find(month.categories, p.categoryId)) > 0)
        .reduce((sum, p) => sum + p.amount, 0);
    }

    /**
     * The whole list, from the budget month's own figures: every ordinary category's cash
     * overspending and reservation shortfall, the card spending of the categories that have both
     * (#731), and each card's to cover less what those categories ask for it.
     */
    function expectedTotal(month: BudgetMonth): number {
      const cash = month.categories.reduce((sum, c) => sum + c.cashOverspending, 0);
      const reservations = month.categories.reduce((sum, c) => sum + shortfall(c) + cardSpendingAsked(c), 0);
      const cards = month.paymentCategories.reduce((sum, c) => sum + Math.max(0, toCover(c) - askedOnCategoriesFor(month, c)), 0);
      return cash + reservations + cards;
    }

    function assertSettled(before: BudgetMonth, after: BudgetMonth, context: string): void {
      for (const card of before.paymentCategories) {
        const settled = find(after.paymentCategories, card.categoryId);
        // A card in credit may stay below zero, down to minus its credit (#660).
        assert.ok(settled.available >= (settled.owed ?? 0), `${context}, card ${card.categoryId}`);
        assert.equal(settled.cashOverspending, 0, `${context}, card ${card.categoryId}`);
      }
      for (const c of after.categories) {
        assert.equal(c.cashOverspending, 0, `${context}, category ${c.categoryId}`);
        // #731: every reservation is funded, a category with card spending included.
        assert.equal(shortfall(c), 0, `${context}, reservation of ${c.categoryId}`);
      }
      assert.deepEqual(coverItems(todosOf(after)), [], context);
    }

    it("the list asks each category's own need and each card's to cover once, and following it once settles every card, every month", () => {
      const random = mulberry32(728);
      let partialTransfers = 0;
      let settledWithTransfer = 0;
      let cardSpendingWithReservation = 0;
      for (let run = 0; run < 500; run++) {
        const input = randomMonth(random);
        const month = computeBudgetMonth(input, MONTH);
        const items = coverItems(todosOf(month));
        const context = `run ${run}: ${JSON.stringify(items)}`;

        // Never two items for the same category.
        assert.equal(new Set(items.map((i) => i.categoryId)).size, items.length, context);

        // The whole list, and nothing else.
        assert.equal(total(items), expectedTotal(month), context);

        // Following every item, in one go: each card's payment category holds what it owes (or
        // what it already held beyond that), no category is left overspent in cash or short of
        // its reservation, and the list asks for nothing more. No month is skipped (#732).
        const followed = followTodos(input, month);
        const after = computeBudgetMonth(followed, MONTH);
        assert.equal(after.unassigned, month.unassigned - total(items), context);
        // Exactly what it owes, unless a category's card spending asked on it was more than the
        // card had to cover (#731): that money then stays set aside for the card.
        const askedBeyond = month.paymentCategories.some((card) => askedOnCategoriesFor(month, card) > toCover(card));
        if (!askedBeyond) {
          for (const card of month.paymentCategories) {
            const settled = find(after.paymentCategories, card.categoryId);
            assert.equal(settled.available, Math.max(card.available, card.owed ?? 0), `${context}, card ${card.categoryId}`);
          }
        }
        assertSettled(month, after, context);
        if (month.categories.some((c) => cardSpendingAsked(c) > 0)) cardSpendingWithReservation++;
        if ((input.cardTransfers ?? []).length > 0) {
          settledWithTransfer++;
          // A transfer that moved less than its amount leaves the charged card something to cover.
          if ((input.cardTransfers ?? []).some((t) => find(month.paymentCategories, t.chargedPaymentCategoryId).uncovered > 0)) partialTransfers++;
        }
      }
      assert.ok(settledWithTransfer > 100, `only ${settledWithTransfer} runs settled with a card-to-card transfer`);
      assert.ok(partialTransfers > 30, `only ${partialTransfers} runs had a charged card left with something to cover`);
      assert.ok(cardSpendingWithReservation > 20, `only ${cardSpendingWithReservation} runs asked card spending with a reservation`);
    });

    it("covering the categories' whole overspend first, then following the list, settles every card too", () => {
      const random = mulberry32(7280);
      let equalRuns = 0;
      let withReservation = 0;
      let askedBeyondRuns = 0;
      for (let run = 0; run < 500; run++) {
        const input = randomMonth(random);
        const month = computeBudgetMonth(input, MONTH);
        const direct = total(coverItems(todosOf(month)));

        // The category first: each one overspent with a card gets its whole overspend, cash and
        // card together, which moves its card part into the cards (rule 4).
        const categoryStep: Assignment[] = month.categories
          .filter((c) => c.creditOverspending > 0)
          .map((c) => ({ categoryId: c.categoryId, month: MONTH, amount: c.cashOverspending + c.creditOverspending }));
        const firstInput: BudgetInput = { ...input, assignments: [...input.assignments, ...categoryStep] };
        const first = computeBudgetMonth(firstInput, MONTH);
        const rest = total(coverItems(todosOf(first)));
        const context = `run ${run}: step ${JSON.stringify(categoryStep)}`;

        for (const c of first.categories) {
          assert.equal(c.creditOverspending, 0, `${context}, category ${c.categoryId}`);
        }
        assertSettled(first, computeBudgetMonth(followTodos(firstInput, first), MONTH), context);

        // The total is the same either way, a reservation behind card spending included (#731),
        // when no card received more from the categories than it had to cover. Otherwise the
        // category-first order asks for more, never less: the money a card gets beyond its to
        // cover stays there — unless the direct list itself asked a card's spending on a category
        // beyond what that card had to cover: that money then stays on the card, or a transfer
        // moves it on to the card that paid it (#732), so the direct list can ask more.
        const movedWithinToCover = month.paymentCategories.every(
          (card) => find(first.paymentCategories, card.categoryId).available - card.available <= toCover(card),
        );
        const askedBeyond = month.paymentCategories.some((card) => askedOnCategoriesFor(month, card) > toCover(card));
        const stepTotal = categoryStep.reduce((sum, a) => sum + a.amount, 0);
        if (askedBeyond && (input.cardTransfers ?? []).length > 0) {
          askedBeyondRuns++;
        } else if (movedWithinToCover) {
          assert.equal(stepTotal + rest, direct, context);
          equalRuns++;
          if (month.categories.some((c) => cardSpendingAsked(c) > 0)) withReservation++;
        } else {
          assert.ok(stepTotal + rest >= direct, context);
        }
      }
      // Kept a small minority, so that the comparison above still runs on most months.
      assert.ok(askedBeyondRuns < 50, `${askedBeyondRuns} runs asked a card's spending beyond its to cover, with a transfer`);
      // The equal case is not vacuous, and covers reservations behind card spending.
      assert.ok(equalRuns > 100, `only ${equalRuns} runs met the conditions`);
      assert.ok(withReservation > 10, `only ${withReservation} equal runs had a reservation behind card spending`);
    });
  });
});
