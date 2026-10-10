import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeBudgetProblems, type BudgetProblemCategory } from "./budgetProblems.ts";

function category(overrides: Partial<BudgetProblemCategory> & { categoryId: string }): BudgetProblemCategory {
  return { available: 0, uncovered: 0, ...overrides };
}

describe("computeBudgetProblems", () => {
  it("reports no problems for a clean month", () => {
    const problems = computeBudgetProblems({
      unassigned: 0,
      categories: [category({ categoryId: "groceries", available: 5_000 })],
    });
    assert.deepEqual(problems, []);
  });

  it("flags a negative category as overspent, by exactly how negative it is", () => {
    const problems = computeBudgetProblems({
      unassigned: 0,
      categories: [category({ categoryId: "groceries", name: "Groceries", groupName: "Everyday", available: -1_200 })],
    });
    assert.deepEqual(problems, [
      { kind: "overspent_category", categoryId: "groceries", name: "Groceries", groupName: "Everyday", amountCents: 1_200 },
    ]);
  });

  it("flags a payment category's own uncovered card debt", () => {
    const problems = computeBudgetProblems({
      unassigned: 0,
      categories: [category({ categoryId: "visa-payment", name: "Visa payment", uncovered: 4_500 })],
    });
    assert.deepEqual(problems, [{ kind: "uncovered_card_debt", categoryId: "visa-payment", name: "Visa payment", amountCents: 4_500 }]);
  });

  it("flags unassigned money sitting idle, with no categoryId of its own", () => {
    const problems = computeBudgetProblems({ unassigned: 10_000, categories: [] });
    assert.deepEqual(problems, [{ kind: "unassigned_money", amountCents: 10_000 }]);
  });

  it("a category can be both overspent and carrying uncovered card debt at once", () => {
    const problems = computeBudgetProblems({
      unassigned: 0,
      categories: [category({ categoryId: "visa-payment", available: -500, uncovered: 500 })],
    });
    assert.deepEqual(problems.map((p) => p.kind).sort(), ["overspent_category", "uncovered_card_debt"]);
  });

  it("omits name/groupName entirely when the caller gives none, rather than undefined fields", () => {
    const problems = computeBudgetProblems({ unassigned: 0, categories: [category({ categoryId: "c1", available: -100 })] });
    assert.deepEqual(Object.keys(problems[0]!).sort(), ["amountCents", "categoryId", "kind"]);
  });
});
