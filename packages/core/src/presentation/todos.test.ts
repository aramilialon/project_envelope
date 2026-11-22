import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CategoryMonth } from "../budget/budget-month.ts";
import { amountNeededToCover, computeTodos, reservationShortfall, type TodosInput } from "./todos.ts";

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

function input(overrides: Partial<TodosInput> = {}): TodosInput {
  return { unassignedCents: 0, categories: [], paymentCategories: [], overdueScheduledItems: [], targetsNeeded: [], ...overrides };
}

describe("computeTodos", () => {
  it("nothing to fix this month is an empty list", () => {
    assert.deepEqual(computeTodos(input()), []);
  });

  it("cash overspending: one item, red-priority, for its own category", () => {
    const items = computeTodos(input({ categories: [category({ categoryId: "groceries", cashOverspending: 5_000 })] }));
    assert.deepEqual(items, [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 5_000 }]);
  });

  it("card overspending alone: no item on the category, its card asks for it (#728)", () => {
    const items = computeTodos(input({ categories: [category({ categoryId: "restaurants", available: -3_000, creditOverspending: 3_000 })] }));
    assert.deepEqual(items, []);
  });

  it("both cash and card overspending in the same category: one item for the cash part only (#728)", () => {
    const items = computeTodos(input({ categories: [category({ categoryId: "groceries", available: -8_000, cashOverspending: 5_000, creditOverspending: 3_000 })] }));
    assert.deepEqual(items, [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 5_000 }]);
  });

  it("an overdue scheduled transaction becomes its own item, carrying the scheduled transaction's own id and date", () => {
    const items = computeTodos(input({ overdueScheduledItems: [{ scheduledTransactionId: "s1", categoryId: "vet", payee: "Vet clinic", date: "2026-09-22", amountCents: 4_500 }] }));
    assert.deepEqual(items, [{ kind: "scheduledOverdue", scheduledTransactionId: "s1", categoryId: "vet", payee: "Vet clinic", date: "2026-09-22", amountCents: 4_500 }]);
  });

  it("a reservation the category cannot cover shows up only when the category is not already overspent", () => {
    const short = category({ categoryId: "maintenance", available: -2_000, reserved: 5_000 }); // beforeReservation = 3,000; short = 2,000
    const items = computeTodos(input({ categories: [short] }));
    assert.deepEqual(items, [{ kind: "reservationShortfall", categoryId: "maintenance", amountCents: 2_000 }]);
  });

  it("already-overspent categories do not also get a reservation-shortfall item: the cash item asks for both", () => {
    const over = category({ categoryId: "groceries", cashOverspending: 1_000, available: -1_500, reserved: 500 });
    const items = computeTodos(input({ categories: [over] }));
    assert.deepEqual(items, [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_500, reservationShortfallCents: 500 }]);
  });

  it("a category overspent with a card and short of its reservation asks both, and its card that much less (#731)", () => {
    // Restaurants: nothing assigned, €30 on the Visa, €10 scheduled in cash. The Visa owes €30.
    const restaurants = category({ categoryId: "restaurants", creditOverspending: 3_000, available: -4_000, reserved: 1_000 });
    const visa = category({ categoryId: "visa", uncovered: 3_000, owed: 3_000, overspendingBy: [{ categoryId: "restaurants", amount: 3_000 }] });
    assert.deepEqual(computeTodos(input({ categories: [restaurants], paymentCategories: [visa] })), [
      { kind: "reservationShortfall", categoryId: "restaurants", amountCents: 4_000, cardSpendingCents: 3_000 },
    ]);

    // The Visa owes €50 in all: it still asks the €20 not asked on Restaurants, and says where the rest is asked.
    const more = { ...visa, uncovered: 5_000, owed: 5_000 };
    assert.deepEqual(computeTodos(input({ categories: [restaurants], paymentCategories: [more] })), [
      { kind: "reservationShortfall", categoryId: "restaurants", amountCents: 4_000, cardSpendingCents: 3_000 },
      { kind: "cardDebtUncovered", categoryId: "visa", amountCents: 2_000, askedOnCategories: [{ categoryId: "restaurants", amountCents: 3_000 }] },
    ]);
  });

  it("cash, card spending and a reservation: one cash item for all three, and the card asks that much less (#731)", () => {
    const groceries = category({ categoryId: "groceries", cashOverspending: 500, creditOverspending: 1_000, available: -2_000, reserved: 500 });
    const visa = category({ categoryId: "visa", available: -100, cashOverspending: 100, uncovered: 1_500, owed: 1_500, overspendingBy: [{ categoryId: "groceries", amount: 1_000 }] });
    assert.deepEqual(computeTodos(input({ categories: [groceries], paymentCategories: [visa] })), [
      { kind: "cashOverspending", categoryId: "groceries", amountCents: 2_000, reservationShortfallCents: 500, cardSpendingCents: 1_000 },
      { kind: "cashOverspending", categoryId: "visa", amountCents: 600, askedOnCategories: [{ categoryId: "groceries", amountCents: 1_000 }] },
    ]);
  });

  it("a category overspent with a card and no reservation shortfall asks nothing: its card asks it", () => {
    const over = category({ categoryId: "groceries", creditOverspending: 1_000, available: -1_000 });
    const visa = category({ categoryId: "visa", uncovered: 1_000, owed: 1_000, overspendingBy: [{ categoryId: "groceries", amount: 1_000 }] });
    assert.deepEqual(computeTodos(input({ categories: [over], paymentCategories: [visa] })), [
      { kind: "cardDebtUncovered", categoryId: "visa", amountCents: 1_000 },
    ]);
  });

  it("a reservation fully covered by the current balance needs nothing", () => {
    const covered = category({ categoryId: "vet", available: 10_000, reserved: 4_500 });
    assert.deepEqual(computeTodos(input({ categories: [covered] })), []);
  });

  it("a credit card's own uncovered debt is its own item, on the payment category", () => {
    const items = computeTodos(input({ paymentCategories: [category({ categoryId: "visa-payment", uncovered: 12_000, owed: 12_000 })] }));
    assert.deepEqual(items, [{ kind: "cardDebtUncovered", categoryId: "visa-payment", amountCents: 12_000 }]);
  });

  it("a card paid beyond what was set aside is one cash overspending item, for the overspending plus the uncovered debt (#699)", () => {
    const visa = category({ categoryId: "visa-payment", available: -25_433, cashOverspending: 25_433, uncovered: 24_567, owed: 24_567 });
    const items = computeTodos(input({ categories: [category({ categoryId: "groceries", cashOverspending: 1_000 })], paymentCategories: [visa] }));
    assert.deepEqual(items, [
      { kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 },
      { kind: "cashOverspending", categoryId: "visa-payment", amountCents: 50_000 },
    ]);
  });

  it("every target still missing money becomes one combined item", () => {
    const items = computeTodos(
      input({ targetsNeeded: [{ categoryId: "vacation", missingCents: 2_000 }, { categoryId: "emergency-fund", missingCents: 3_000 }] }),
    );
    assert.deepEqual(items, [{ kind: "targetsNeeded", categoryIds: ["vacation", "emergency-fund"], amountCents: 5_000 }]);
  });

  it("being assigned more than there is money for comes first, ahead of everything else", () => {
    const items = computeTodos(
      input({ unassignedCents: -1_000, categories: [category({ categoryId: "groceries", cashOverspending: 5_000 })] }),
    );
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { kind: "overassigned", amountCents: 1_000 });
  });

  it("every kind together keeps the mockup's own priority order", () => {
    const items = computeTodos({
      unassignedCents: -500,
      categories: [
        category({ categoryId: "groceries", cashOverspending: 1_000 }),
        category({ categoryId: "restaurants", available: -2_000, creditOverspending: 2_000 }),
        category({ categoryId: "maintenance", available: -1_000, reserved: 3_000 }),
      ],
      paymentCategories: [category({ categoryId: "visa-payment", uncovered: 4_000 })],
      overdueScheduledItems: [{ scheduledTransactionId: "s1", categoryId: "vet", payee: "Vet clinic", date: "2026-09-22", amountCents: 500 }],
      targetsNeeded: [{ categoryId: "vacation", missingCents: 1_500 }],
    });
    assert.deepEqual(
      items.map((i) => i.kind),
      ["overassigned", "cashOverspending", "scheduledOverdue", "reservationShortfall", "cardDebtUncovered", "targetsNeeded"],
    );
  });
});

describe("amountNeededToCover", () => {
  it("nothing wrong: zero", () => {
    assert.equal(amountNeededToCover(category()), 0);
  });

  it("cash overspending alone", () => {
    assert.equal(amountNeededToCover(category({ cashOverspending: 5_000 })), 5_000);
  });

  it("cash and card overspending together: the cash part only, the card asks for the rest (#728)", () => {
    assert.equal(amountNeededToCover(category({ available: -3_000, cashOverspending: 1_000, creditOverspending: 2_000 })), 1_000);
  });

  it("card overspending alone: nothing, the card asks for it (#728)", () => {
    assert.equal(amountNeededToCover(category({ available: -3_000, creditOverspending: 3_000 })), 0);
  });

  it("card overspending and a reservation: both, since money assigned there covers the card spending first (#731)", () => {
    assert.equal(amountNeededToCover(category({ available: -4_000, creditOverspending: 3_000, reserved: 1_000 })), 4_000);
  });

  it("cash, card overspending and a reservation: all three (#731)", () => {
    assert.equal(amountNeededToCover(category({ available: -2_000, cashOverspending: 500, creditOverspending: 1_000, reserved: 500 })), 2_000);
  });

  it("a reservation shortfall, when there is no overspending", () => {
    assert.equal(amountNeededToCover(category({ available: -1_000, reserved: 3_000 })), 1_000);
  });

  it("cash overspending and a reservation: both, so the category ends at zero", () => {
    assert.equal(amountNeededToCover(category({ cashOverspending: 500, available: -3_500, reserved: 3_000 })), 3_500);
  });

  it("a payment category's uncovered card debt, when nothing else applies", () => {
    assert.equal(amountNeededToCover(category({ uncovered: 4_000 })), 4_000);
  });

  it("a card paid beyond what was set aside: its cash overspending plus its uncovered debt (#699)", () => {
    assert.equal(amountNeededToCover(category({ available: -25_433, cashOverspending: 25_433, uncovered: 24_567, owed: 24_567 })), 50_000);
  });
});

describe("reservationShortfall", () => {
  it("nothing reserved: zero", () => {
    assert.equal(reservationShortfall(category()), 0);
  });

  it("the reservation is fully covered by the current balance: zero", () => {
    assert.equal(reservationShortfall(category({ available: 1_000, reserved: 3_000 })), 0);
  });

  it("the balance cannot cover all of it: the shortfall, capped at the reservation itself", () => {
    assert.equal(reservationShortfall(category({ available: -1_000, reserved: 3_000 })), 1_000);
  });

  it("a wholly negative balance before the reservation: the whole reservation is short", () => {
    assert.equal(reservationShortfall(category({ available: -5_000, reserved: 3_000 })), 3_000);
  });
});
