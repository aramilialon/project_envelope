import { sumCents, type Cents } from "../money.ts";

/** The little the accounts panel needs to know about one open account. */
export interface PanelAccount {
  readonly id: string;
  /** A credit card, which gets its own group whether or not it is on budget. */
  readonly isCard: boolean;
  readonly onBudget: boolean;
  /** Its balance in `currency`, signed the way the register's own total is: a card's debt is negative. */
  readonly balance: Cents;
  /** The account's own currency (ISO 4217). */
  readonly currency: string;
}

/** What one currency other than the base one holds, left out of the net worth (#652). */
export interface ExcludedAmount {
  readonly currency: string;
  /** Every balance in `currency` summed, in that currency's own minor units. */
  readonly amount: Cents;
}

export interface AccountsPanelGroups<A extends PanelAccount> {
  /**
   * Every base-currency account's balance summed, on and off budget, cards included (design.md,
   * "Band"). An account in another currency is left out (#652): with no exchange rates yet, its
   * money cannot be added to the base currency's.
   */
  readonly netWorth: Cents;
  /**
   * The balances left out of `netWorth`, summed per currency and sorted by currency code; a
   * currency whose balances sum to zero leaves nothing out and is not listed.
   */
  readonly excluded: readonly ExcludedAmount[];
  /** On-budget accounts that are not credit cards. */
  readonly onBudget: readonly A[];
  /** Every credit card, on budget or not, so none is listed twice. */
  readonly cards: readonly A[];
  /** Off-budget accounts that are not credit cards. */
  readonly offBudget: readonly A[];
}

/**
 * The accounts panel's own grouping and total (#412, `docs/ux/mockups/accounts-panel.html`):
 * the workspace's net worth at its head, then on-budget accounts, credit cards and off-budget
 * accounts, each group keeping the order the accounts came in. Callers pass open accounts only;
 * a closed account is neither listed nor counted. The net worth is in `baseCurrency` (the
 * workspace's) and never adds two currencies together: what other currencies hold comes back in
 * `excluded`, each in its own currency (#652). Plain data out, no text (no user-facing text in
 * `packages/core`).
 */
export function groupAccountsForPanel<A extends PanelAccount>(accounts: readonly A[], baseCurrency: string): AccountsPanelGroups<A> {
  const otherCurrencies = new Map<string, Cents[]>();
  for (const account of accounts) {
    if (account.currency !== baseCurrency) {
      otherCurrencies.set(account.currency, [...(otherCurrencies.get(account.currency) ?? []), account.balance]);
    }
  }
  const excluded = [...otherCurrencies]
    .map(([currency, balances]) => ({ currency, amount: sumCents(balances) }))
    .filter((entry) => entry.amount !== 0)
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  return {
    netWorth: sumCents(accounts.filter((a) => a.currency === baseCurrency).map((a) => a.balance)),
    excluded,
    onBudget: accounts.filter((a) => !a.isCard && a.onBudget),
    cards: accounts.filter((a) => a.isCard),
    offBudget: accounts.filter((a) => !a.isCard && !a.onBudget),
  };
}
