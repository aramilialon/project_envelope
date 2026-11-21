import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { availableAfterInflow, transferCategoryRule } from "./transferCategory.ts";

const cash = { onBudget: true, creditCard: false };
const card = { onBudget: true, creditCard: true };
const broker = { onBudget: false, creditCard: false };
const offBudgetCard = { onBudget: false, creditCard: true };

describe("transferCategoryRule", () => {
  it("takes no category between two on-budget accounts, a card payment included", () => {
    assert.equal(transferCategoryRule(cash, cash), "none");
    assert.equal(transferCategoryRule(cash, card), "none");
    assert.equal(transferCategoryRule(card, card), "none");
  });

  it("takes no category between two off-budget accounts", () => {
    assert.equal(transferCategoryRule(broker, broker), "none");
    assert.equal(transferCategoryRule(broker, offBudgetCard), "none");
  });

  it("requires a category when the money leaves the budget", () => {
    assert.equal(transferCategoryRule(cash, broker), "required");
    assert.equal(transferCategoryRule(card, broker), "required");
  });

  it("makes the category optional (Unassigned by default) from an off-budget account into a cash account", () => {
    assert.equal(transferCategoryRule(broker, cash), "optional");
    assert.equal(transferCategoryRule(offBudgetCard, cash), "optional");
  });

  it("requires a category from an off-budget account into an on-budget card, where income is not modeled", () => {
    assert.equal(transferCategoryRule(broker, card), "required");
  });
});

describe("availableAfterInflow", () => {
  it("adds the inflow to what the destination holds", () => {
    assert.deepEqual(availableAfterInflow(31_200, 500_000), { fromCents: 31_200, toCents: 531_200 });
  });

  it("starts from a negative available amount, as overspending or over-assigning leave it", () => {
    assert.deepEqual(availableAfterInflow(-380_000, 500_000), { fromCents: -380_000, toCents: 120_000 });
  });
});
