import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CategoryMonth } from "../budget/budget-month.ts";
import { amountNeededToCover, computeTodos, type TodosInput } from "./todos.ts";

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

  it("card overspending alone: its own item, the card's own amount", () => {
    const items = computeTodos(input({ categories: [category({ categoryId: "restaurants", creditOverspending: 3_000 })] }));
    assert.deepEqual(items, [{ kind: "cardOverspending", categoryId: "restaurants", amountCents: 3_000 }]);
  });

  it("both cash and card overspending in the same category: one cash item covering the whole amount", () => {
    const items = computeTodos(input({ categories: [category({ categoryId: "groceries", cashOverspending: 5_000, creditOverspending: 3_000 })] }));
    assert.deepEqual(items, [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 8_000 }]);
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

  it("already-overspent categories do not also get a reservation-shortfall item", () => {
    const over = category({ categoryId: "groceries", cashOverspending: 1_000, available: -1_000, reserved: 500 });
    const items = computeTodos(input({ categories: [over] }));
    assert.deepEqual(items, [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 }]);
  });

  it("a reservation fully covered by the current balance needs nothing", () => {
    const covered = category({ categoryId: "vet", available: 10_000, reserved: 4_500 });
    assert.deepEqual(computeTodos(input({ categories: [covered] })), []);
  });

  it("a credit card's own uncovered debt is its own item, on the payment category", () => {
    const items = computeTodos(input({ paymentCategories: [category({ categoryId: "visa-payment", uncovered: 12_000 })] }));
    assert.deepEqual(items, [{ kind: "cardDebtUncovered", categoryId: "visa-payment", amountCents: 12_000 }]);
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
        category({ categoryId: "restaurants", creditOverspending: 2_000 }),
        category({ categoryId: "maintenance", available: -1_000, reserved: 3_000 }),
      ],
      paymentCategories: [category({ categoryId: "visa-payment", uncovered: 4_000 })],
      overdueScheduledItems: [{ scheduledTransactionId: "s1", categoryId: "vet", payee: "Vet clinic", date: "2026-09-22", amountCents: 500 }],
      targetsNeeded: [{ categoryId: "vacation", missingCents: 1_500 }],
    });
    assert.deepEqual(
      items.map((i) => i.kind),
      ["overassigned", "cashOverspending", "cardOverspending", "scheduledOverdue", "reservationShortfall", "cardDebtUncovered", "targetsNeeded"],
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

  it("cash and card overspending together: the whole of both", () => {
    assert.equal(amountNeededToCover(category({ cashOverspending: 1_000, creditOverspending: 2_000 })), 3_000);
  });

  it("card overspending alone", () => {
    assert.equal(amountNeededToCover(category({ creditOverspending: 3_000 })), 3_000);
  });

  it("a reservation shortfall, when there is no overspending", () => {
    assert.equal(amountNeededToCover(category({ available: -1_000, reserved: 3_000 })), 1_000);
  });

  it("overspending wins over a reservation shortfall on the same category", () => {
    assert.equal(amountNeededToCover(category({ cashOverspending: 500, available: -1_000, reserved: 3_000 })), 500);
  });

  it("a payment category's uncovered card debt, when nothing else applies", () => {
    assert.equal(amountNeededToCover(category({ uncovered: 4_000 })), 4_000);
  });
});
