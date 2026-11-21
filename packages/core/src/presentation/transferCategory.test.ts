import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { availableAfterInflow, transferCategoryRule } from "./transferCategory.ts";
import { incomeReceived } from "../budget/budget-month.ts";

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
    assert.deepEqual(availableAfterInflow(31_200, 500_000), { received: true, fromCents: 31_200, toCents: 531_200 });
  });

  it("starts from a negative available amount, as overspending or over-assigning leave it", () => {
    assert.deepEqual(availableAfterInflow(-380_000, 500_000), { received: true, fromCents: -380_000, toCents: 120_000 });
  });

  it("adds money dated today", () => {
    assert.deepEqual(availableAfterInflow(20_000, 500_000, { date: "2026-11-21", today: "2026-11-21" }), {
      received: true,
      fromCents: 20_000,
      toCents: 520_000,
    });
  });

  it("adds money dated yesterday", () => {
    assert.deepEqual(availableAfterInflow(20_000, 500_000, { date: "2026-11-20", today: "2026-11-21" }), {
      received: true,
      fromCents: 20_000,
      toCents: 520_000,
    });
  });

  it("does not add money dated tomorrow: it comes in on its date", () => {
    assert.deepEqual(availableAfterInflow(20_000, 500_000, { date: "2026-11-22", today: "2026-11-21" }), {
      received: false,
      date: "2026-11-22",
    });
  });

  it("does not add money dated in a later month either", () => {
    assert.deepEqual(availableAfterInflow(20_000, 500_000, { date: "2026-12-05", today: "2026-11-21" }), {
      received: false,
      date: "2026-12-05",
    });
  });

  it("reads today in the workspace's time zone, not in UTC", () => {
    // 23:30 UTC on 21 November is already 22 November in Rome and still 21 November in New York.
    const instant = new Date("2026-11-21T23:30:00Z");
    const dayIn = (timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
    const timing = (timeZone: string) => ({ date: "2026-11-22", today: dayIn(timeZone) });
    assert.equal(dayIn("Europe/Rome"), "2026-11-22");
    assert.equal(dayIn("America/New_York"), "2026-11-21");
    assert.deepEqual(availableAfterInflow(0, 500_000, timing("Europe/Rome")), { received: true, fromCents: 0, toCents: 500_000 });
    assert.deepEqual(availableAfterInflow(0, 500_000, timing("America/New_York")), { received: false, date: "2026-11-22" });
  });
});

describe("incomeReceived", () => {
  it("counts income from its own date on", () => {
    assert.equal(incomeReceived("2026-11-20", "2026-11-21"), true);
    assert.equal(incomeReceived("2026-11-21", "2026-11-21"), true);
    assert.equal(incomeReceived("2026-11-22", "2026-11-21"), false);
    assert.equal(incomeReceived("2027-01-01", "2026-12-31"), false);
  });
});
