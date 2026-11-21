import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupAccountsForPanel, type PanelAccount } from "./accountsPanel.ts";

function account(id: string, overrides: Partial<PanelAccount> = {}): PanelAccount {
  return { id, isCard: false, onBudget: true, balance: 0, currency: "EUR", ...overrides };
}

const ids = (accounts: readonly PanelAccount[]) => accounts.map((a) => a.id);

describe("groupAccountsForPanel", () => {
  it("is empty, with a net worth of zero, without any account", () => {
    const groups = groupAccountsForPanel([], "EUR");
    assert.equal(groups.netWorth, 0);
    assert.deepEqual(groups.excluded, []);
    assert.deepEqual([groups.onBudget, groups.cards, groups.offBudget], [[], [], []]);
  });

  it("sums every balance into the net worth, off budget and card debt included (the mockup's own household)", () => {
    const groups = groupAccountsForPanel(
      [
        account("checking", { balance: 341_258 }),
        account("savings", { balance: 800_000 }),
        account("cash", { balance: 8_540 }),
        account("broker", { onBudget: false, balance: 2_150_000 }),
        account("visa", { isCard: true, balance: -64_230 }),
        account("mastercard", { isCard: true, balance: -120_000 }),
      ],
      "EUR",
    );
    assert.equal(groups.netWorth, 3_115_568);
    assert.deepEqual(groups.excluded, []);
    assert.deepEqual(ids(groups.onBudget), ["checking", "savings", "cash"]);
    assert.deepEqual(ids(groups.cards), ["visa", "mastercard"]);
    assert.deepEqual(ids(groups.offBudget), ["broker"]);
  });

  it("lists an off-budget card once, with the cards, never also off budget", () => {
    const groups = groupAccountsForPanel([account("store-card", { isCard: true, onBudget: false, balance: -5_000 })], "EUR");
    assert.deepEqual(ids(groups.cards), ["store-card"]);
    assert.deepEqual(groups.offBudget, []);
    assert.equal(groups.netWorth, -5_000);
  });

  it("can be negative, when debt outweighs everything else", () => {
    const groups = groupAccountsForPanel([account("checking", { balance: 1_000 }), account("card", { isCard: true, balance: -9_000 })], "EUR");
    assert.equal(groups.netWorth, -8_000);
  });

  it("keeps each group in the order the accounts came in", () => {
    const groups = groupAccountsForPanel([account("b"), account("a"), account("c")], "EUR");
    assert.deepEqual(ids(groups.onBudget), ["b", "a", "c"]);
  });

  it("adds base-currency balances only, and sums what each other currency holds in its own (#652)", () => {
    const groups = groupAccountsForPanel(
      [
        account("checking", { balance: 100_000 }),
        account("us-broker", { onBudget: false, currency: "USD", balance: 300_000 }),
        account("eu-broker", { onBudget: false, balance: 50_000 }),
        account("swiss-account", { onBudget: false, currency: "CHF", balance: 20_000 }),
        account("us-card", { isCard: true, onBudget: false, currency: "USD", balance: -10_000 }),
      ],
      "EUR",
    );
    assert.equal(groups.netWorth, 150_000);
    assert.deepEqual(groups.excluded, [
      { currency: "CHF", amount: 20_000 },
      { currency: "USD", amount: 290_000 },
    ]);
    // Every account is still listed in its group, whatever its currency.
    assert.deepEqual(ids(groups.offBudget), ["us-broker", "eu-broker", "swiss-account"]);
    assert.deepEqual(ids(groups.cards), ["us-card"]);
  });

  it("does not list a currency whose balances sum to zero", () => {
    const groups = groupAccountsForPanel(
      [account("checking", { balance: 1_000 }), account("usd", { onBudget: false, currency: "USD", balance: 0 })],
      "EUR",
    );
    assert.deepEqual(groups.excluded, []);
    assert.equal(groups.netWorth, 1_000);
  });

  it("is zero when every account is in another currency", () => {
    const groups = groupAccountsForPanel([account("usd", { onBudget: false, currency: "USD", balance: 5_000 })], "EUR");
    assert.equal(groups.netWorth, 0);
    assert.deepEqual(groups.excluded, [{ currency: "USD", amount: 5_000 }]);
  });

  it("counts an on-budget base-currency card in the net worth, and nets an off-budget card into its own currency (#652)", () => {
    const groups = groupAccountsForPanel(
      [
        account("checking", { balance: 700_000 }),
        account("visa", { isCard: true, balance: -50_000 }),
        account("us-card", { isCard: true, onBudget: false, currency: "USD", balance: -10_000 }),
        account("us-broker", { onBudget: false, currency: "USD", balance: 300_000 }),
      ],
      "EUR",
    );
    assert.equal(groups.netWorth, 650_000);
    assert.deepEqual(groups.excluded, [{ currency: "USD", amount: 290_000 }]);
    assert.deepEqual(ids(groups.cards), ["visa", "us-card"]);
  });

  it("lists a lone debt in another currency as a negative amount (#652)", () => {
    const groups = groupAccountsForPanel([account("us-loan", { onBudget: false, currency: "USD", balance: -500_000 })], "EUR");
    assert.equal(groups.netWorth, 0);
    assert.deepEqual(groups.excluded, [{ currency: "USD", amount: -500_000 }]);
  });
});
