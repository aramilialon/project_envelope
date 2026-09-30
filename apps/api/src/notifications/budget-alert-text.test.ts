import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BudgetProblem } from "../budget/repository.ts";
import { composeBudgetAlert } from "./budget-alert-text.ts";

describe("composeBudgetAlert (#40)", () => {
  const overspent: BudgetProblem = { kind: "overspent_category", categoryId: "cat-1", name: "Groceries", groupName: "Home", amountCents: 5_000 };
  const uncovered: BudgetProblem = { kind: "uncovered_card_debt", categoryId: "cat-2", name: "Card payment", groupName: "Home", amountCents: 3_000 };
  const unassigned: BudgetProblem = { kind: "unassigned_money", amountCents: 12_000 };

  it("renders a single problem in English by default", () => {
    const content = composeBudgetAlert([overspent], { language: "fr", locale: "en-US", currency: "EUR" });
    assert.equal(content.title, "Budget alert");
    assert.equal(content.body, `"Groceries" is €50.00 over budget.`);
  });

  it("renders a single problem in Italian for an Italian-speaking member", () => {
    const content = composeBudgetAlert([overspent], { language: "it", locale: "it-IT", currency: "EUR" });
    assert.equal(content.title, "Avviso di budget");
    assert.match(content.body, /Groceries.*supera il budget/);
  });

  it("covers every budget problem kind", () => {
    const content = composeBudgetAlert([overspent, uncovered, unassigned], { language: "en", locale: "en-US", currency: "EUR" });
    assert.equal(content.title, "3 budget alerts");
    assert.match(content.body, /Groceries.*over budget/);
    assert.match(content.body, /Card payment.*card debt/);
    assert.match(content.body, /is ready to be assigned/);
  });
});
