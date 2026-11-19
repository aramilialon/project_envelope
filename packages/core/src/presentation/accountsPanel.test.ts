import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupAccountsForPanel, type PanelAccount } from "./accountsPanel.ts";

function account(id: string, overrides: Partial<PanelAccount> = {}): PanelAccount {
  return { id, isCard: false, onBudget: true, balance: 0, ...overrides };
}

const ids = (accounts: readonly PanelAccount[]) => accounts.map((a) => a.id);

describe("groupAccountsForPanel", () => {
  it("is empty, with a net worth of zero, without any account", () => {
    const groups = groupAccountsForPanel([]);
    assert.equal(groups.netWorth, 0);
    assert.deepEqual([groups.onBudget, groups.cards, groups.offBudget], [[], [], []]);
  });

  it("sums every balance into the net worth, off budget and card debt included (the mockup's own household)", () => {
    const groups = groupAccountsForPanel([
      account("checking", { balance: 341_258 }),
      account("savings", { balance: 800_000 }),
      account("cash", { balance: 8_540 }),
      account("broker", { onBudget: false, balance: 2_150_000 }),
      account("visa", { isCard: true, balance: -64_230 }),
      account("mastercard", { isCard: true, balance: -120_000 }),
    ]);
    assert.equal(groups.netWorth, 3_115_568);
    assert.deepEqual(ids(groups.onBudget), ["checking", "savings", "cash"]);
    assert.deepEqual(ids(groups.cards), ["visa", "mastercard"]);
    assert.deepEqual(ids(groups.offBudget), ["broker"]);
  });

  it("lists an off-budget card once, with the cards, never also off budget", () => {
    const groups = groupAccountsForPanel([account("store-card", { isCard: true, onBudget: false, balance: -5_000 })]);
    assert.deepEqual(ids(groups.cards), ["store-card"]);
    assert.deepEqual(groups.offBudget, []);
    assert.equal(groups.netWorth, -5_000);
  });

  it("can be negative, when debt outweighs everything else", () => {
    assert.equal(groupAccountsForPanel([account("checking", { balance: 1_000 }), account("card", { isCard: true, balance: -9_000 })]).netWorth, -8_000);
  });

  it("keeps each group in the order the accounts came in", () => {
    const groups = groupAccountsForPanel([account("b"), account("a"), account("c")]);
    assert.deepEqual(ids(groups.onBudget), ["b", "a", "c"]);
  });
});
