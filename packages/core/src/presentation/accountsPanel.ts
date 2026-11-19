import { sumCents, type Cents } from "../money.ts";

/** The little the accounts panel needs to know about one open account. */
export interface PanelAccount {
  readonly id: string;
  /** A credit card, which gets its own group whether or not it is on budget. */
  readonly isCard: boolean;
  readonly onBudget: boolean;
  /** Its balance, signed the way the register's own total is: a card's debt is negative. */
  readonly balance: Cents;
}

export interface AccountsPanelGroups<A extends PanelAccount> {
  /** Every account's balance summed, on and off budget, cards included (design.md, "Band"). */
  readonly netWorth: Cents;
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
 * a closed account is neither listed nor counted. Plain data out, no text (no user-facing text in
 * `packages/core`).
 */
export function groupAccountsForPanel<A extends PanelAccount>(accounts: readonly A[]): AccountsPanelGroups<A> {
  return {
    netWorth: sumCents(accounts.map((a) => a.balance)),
    onBudget: accounts.filter((a) => !a.isCard && a.onBudget),
    cards: accounts.filter((a) => a.isCard),
    offBudget: accounts.filter((a) => !a.isCard && !a.onBudget),
  };
}
