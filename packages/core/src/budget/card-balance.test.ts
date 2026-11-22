import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cardDebt } from "../presentation/cardDebt.ts";
import { computeBudgetProblems } from "../presentation/budgetProblems.ts";
import { computeTodos } from "../presentation/todos.ts";
import type { Activity, BudgetInput, BudgetMonth, CategoryMonth } from "./budget-month.ts";
import { computeBudgetMonth } from "./budget-month.ts";
import type { CardTransaction } from "./card-balance.ts";
import { owedAsOf } from "./card-balance.ts";

function find(categories: readonly CategoryMonth[], id: string): CategoryMonth {
  const found = categories.find((c) => c.categoryId === id);
  assert.ok(found, `category ${id} missing`);
  return found;
}

function todosOf(month: BudgetMonth) {
  return computeTodos({
    unassignedCents: month.unassigned,
    categories: month.categories,
    paymentCategories: month.paymentCategories,
    overdueScheduledItems: [],
    targetsNeeded: [],
  });
}

describe("owedAsOf", () => {
  const transactions: readonly CardTransaction[] = [
    { date: "2026-11-10", amount: -10_000 }, // a purchase
    { date: "2026-09-01", amount: -50_000 }, // a starting balance, listed out of order
    { date: "2026-11-20", amount: 10_000 }, // a payment
    { date: "2026-11-30", amount: 3_000 }, // a refund on the last day of the month
    { date: "2026-12-01", amount: -2_000 }, // the first day of the next month
  ];

  it("is minus the sum of the card's transactions up to the end of the month, positive when owed", () => {
    assert.equal(owedAsOf(transactions, "2026-08"), 0);
    assert.equal(owedAsOf(transactions, "2026-09"), 50_000);
    assert.equal(owedAsOf(transactions, "2026-11"), 47_000);
    assert.equal(owedAsOf(transactions, "2026-12"), 49_000);
  });

  it("is negative for a card in credit, and 0, never −0, for a card with nothing on it", () => {
    assert.equal(owedAsOf([{ date: "2026-11-05", amount: 3_000 }], "2026-11"), -3_000);
    assert.ok(Object.is(owedAsOf([], "2026-11"), 0));
  });
});

/**
 * The domain expert's ruling on #660: Groceries gets €100 in November, €100 of groceries go on the
 * card, the card is paid €100 from checking, then €30 of them are refunded on the card.
 */
describe("a card in credit is not cash overspending (#660)", () => {
  const CARD = "visa-payment";
  const november: Activity[] = [
    { categoryId: "groceries", month: "2026-11", date: "2026-11-05", amount: -10_000, paymentCategoryId: CARD },
    { categoryId: "groceries", month: "2026-11", date: "2026-11-20", amount: 3_000, paymentCategoryId: CARD },
  ];
  const novemberCard: CardTransaction[] = [
    { date: "2026-11-05", amount: -10_000 },
    { date: "2026-11-15", amount: 10_000 }, // the payment from checking
    { date: "2026-11-20", amount: 3_000 },
  ];

  function input(december: { activity?: Activity[]; card?: CardTransaction[] } = {}): BudgetInput {
    return {
      categoryIds: ["groceries", "restaurants"],
      paymentCategoryIds: [CARD],
      income: [{ month: "2026-11", date: "2026-11-01", amount: 100_000 }],
      assignments: [{ categoryId: "groceries", month: "2026-11", amount: 10_000 }],
      activity: [...november, ...(december.activity ?? [])],
      cardPayments: [{ paymentCategoryId: CARD, month: "2026-11", amount: 10_000 }],
      cardBalances: [{ paymentCategoryId: CARD, transactions: [...novemberCard, ...(december.card ?? [])] }],
      today: "2026-12-31",
    };
  }

  it("November: Groceries +€30, the payment category −€30, the card €30 in credit, no cash overspending", () => {
    const month = computeBudgetMonth(input(), "2026-11");
    assert.equal(find(month.categories, "groceries").available, 3_000);
    const card = find(month.paymentCategories, CARD);
    assert.equal(card.activity, -3_000); // €70 moved in, €100 paid
    assert.equal(card.available, -3_000);
    assert.equal(card.owed, -3_000);
    assert.equal(card.cashOverspending, 0);
    assert.equal(card.uncovered, 0);
    assert.deepEqual(cardDebt(card), { owed: -3_000, setAside: 0, paidBeyondSetAside: 0, uncovered: 0, toCover: 0 });
    assert.deepEqual(todosOf(month), []);
    assert.deepEqual(
      computeBudgetProblems({ unassigned: 0, categories: [...month.categories, ...month.paymentCategories] }).filter((p) => p.kind !== "unassigned_money"),
      [],
    );
  });

  it("December with nothing new: the −€30 carries over, and nothing is taken from unassigned money", () => {
    const month = computeBudgetMonth(input(), "2026-12");
    const card = find(month.paymentCategories, CARD);
    assert.equal(card.carriedOver, -3_000);
    assert.equal(card.available, -3_000);
    assert.equal(card.cashOverspending, 0);
    assert.equal(month.overspentLastMonth, 0);
    assert.equal(month.unassigned, 90_000); // €1,000 − €100 assigned, nothing taken for the card
    assert.equal(find(month.categories, "groceries").carriedOver, 3_000);
  });

  it("December (a): €30 of groceries on the card spends the credit, and the payment category is back to €0", () => {
    const month = computeBudgetMonth(
      input({
        activity: [{ categoryId: "groceries", month: "2026-12", date: "2026-12-03", amount: -3_000, paymentCategoryId: CARD }],
        card: [{ date: "2026-12-03", amount: -3_000 }],
      }),
      "2026-12",
    );
    assert.equal(find(month.categories, "groceries").available, 0);
    const card = find(month.paymentCategories, CARD);
    assert.equal(card.available, 0);
    assert.equal(card.owed, 0);
    assert.equal(card.cashOverspending, 0);
    assert.equal(cardDebt(card).toCover, 0);
    assert.deepEqual(todosOf(month), []);
  });

  it("December (b): €30 in Restaurants with nothing assigned: the credit is gone, the card asks €30, Restaurants nothing", () => {
    const withRestaurants = input({
      activity: [{ categoryId: "restaurants", month: "2026-12", date: "2026-12-03", amount: -3_000, paymentCategoryId: CARD }],
      card: [{ date: "2026-12-03", amount: -3_000 }],
    });
    const month = computeBudgetMonth(withRestaurants, "2026-12");
    const restaurants = find(month.categories, "restaurants");
    assert.equal(restaurants.creditOverspending, 3_000);
    assert.equal(restaurants.cashOverspending, 0);
    const card = find(month.paymentCategories, CARD);
    assert.equal(card.owed, 0);
    assert.equal(card.available, -3_000);
    assert.equal(card.cashOverspending, 3_000);
    assert.deepEqual(cardDebt(card), { owed: 0, setAside: 0, paidBeyondSetAside: 3_000, uncovered: 0, toCover: 3_000 });
    assert.deepEqual(todosOf(month), [{ kind: "cashOverspending", categoryId: CARD, amountCents: 3_000 }]);

    // Left uncovered, January's unassigned money is €30 lower.
    const january = computeBudgetMonth(withRestaurants, "2027-01");
    assert.equal(january.overspentLastMonth, 3_000);
    assert.equal(january.unassigned, 90_000 - 3_000);
    assert.equal(find(january.paymentCategories, CARD).carriedOver, 0);
    assert.equal(find(january.categories, "restaurants").carriedOver, 0);

    // Covered in December from unassigned money, January takes nothing.
    const covered = computeBudgetMonth(
      { ...withRestaurants, assignments: [...withRestaurants.assignments, { categoryId: CARD, month: "2026-12", amount: 3_000 }] },
      "2027-01",
    );
    assert.equal(covered.overspentLastMonth, 0);
    assert.equal(covered.unassigned, 90_000 - 3_000);
  });

  it("earlier months do not change: October before the refund, November whatever December holds", () => {
    const december = input({
      activity: [{ categoryId: "restaurants", month: "2026-12", date: "2026-12-03", amount: -3_000, paymentCategoryId: CARD }],
      card: [{ date: "2026-12-03", amount: -3_000 }],
    });
    assert.deepEqual(computeBudgetMonth(december, "2026-11"), computeBudgetMonth(input(), "2026-11"));
    assert.deepEqual(computeBudgetMonth(december, "2026-10"), computeBudgetMonth(input(), "2026-10"));
    assert.equal(computeBudgetMonth(december, "2026-10").unassigned, 0);
  });

  it("the domain guide's edge case: owes −€10, available −€50: €40 of cash overspending, €40 to cover", () => {
    const month = computeBudgetMonth(
      {
        categoryIds: [],
        paymentCategoryIds: [CARD],
        income: [{ month: "2026-11", amount: 100_000 }],
        assignments: [],
        activity: [],
        cardPayments: [{ paymentCategoryId: CARD, month: "2026-11", amount: 5_000 }],
        cardBalances: [{ paymentCategoryId: CARD, transactions: [{ date: "2026-11-01", amount: -4_000 }, { date: "2026-11-10", amount: 5_000 }] }],
        today: "2026-11-30",
      },
      "2026-11",
    );
    const card = find(month.paymentCategories, CARD);
    assert.equal(card.owed, -1_000);
    assert.equal(card.available, -5_000);
    assert.equal(card.cashOverspending, 4_000);
    assert.equal(cardDebt(card).paidBeyondSetAside, 4_000);
    assert.equal(cardDebt(card).toCover, 4_000);
    // The next month takes the €40 and carries the €10 of credit over.
    const december = computeBudgetMonth(
      {
        categoryIds: [],
        paymentCategoryIds: [CARD],
        income: [{ month: "2026-11", amount: 100_000 }],
        assignments: [],
        activity: [],
        cardPayments: [{ paymentCategoryId: CARD, month: "2026-11", amount: 5_000 }],
        cardBalances: [{ paymentCategoryId: CARD, transactions: [{ date: "2026-11-01", amount: -4_000 }, { date: "2026-11-10", amount: 5_000 }] }],
        today: "2026-12-31",
      },
      "2026-12",
    );
    assert.equal(december.overspentLastMonth, 4_000);
    assert.equal(find(december.paymentCategories, CARD).carriedOver, -1_000);
    assert.equal(december.unassigned, 100_000 - 4_000);
  });

  it("the credit taken back as cash (a negative card payment) brings the payment category back to €0", () => {
    const month = computeBudgetMonth(
      {
        ...input(),
        cardPayments: [
          { paymentCategoryId: CARD, month: "2026-11", amount: 10_000 },
          { paymentCategoryId: CARD, month: "2026-12", amount: -3_000 },
        ],
        cardBalances: [{ paymentCategoryId: CARD, transactions: [...novemberCard, { date: "2026-12-02", amount: -3_000 }] }],
      },
      "2026-12",
    );
    const card = find(month.paymentCategories, CARD);
    assert.equal(card.owed, 0);
    assert.equal(card.available, 0);
    assert.equal(card.cashOverspending, 0);
  });
});
