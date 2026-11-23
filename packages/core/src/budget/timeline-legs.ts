/**
 * Which recorded legs the budget month's own timeline counts (#326, #659). The timeline is the net
 * movement of every on-budget account, credit cards included; these predicates decide, leg by leg
 * (one split of one transaction), whether that leg is part of it. The one-account register
 * timeline does not use them: it shows every leg of its own account (#337), less a card's
 * starting balance.
 */

/**
 * A credit card's own "Starting balance" transaction: the one and only split of a transaction
 * that is not a transfer, categorized to that same card's own payment category. No ordinary
 * transaction produces that combination: spending uses a regular category, a card payment is a
 * transfer with no category at all, and a cash account's own income has no payment category to
 * match (`paymentCategoryId` is `null` for a cash account).
 *
 * It feeds only the card's balance (`owedAsOf`), never `aggregateTransactions`, and it is not
 * something that happened in the budget sense, so neither timeline draws it.
 */
export function isStartingBalanceSplit(input: {
  readonly transferId: string | null;
  readonly splitCount: number;
  readonly categoryId: string | null;
  readonly paymentCategoryId: string | null;
}): boolean {
  return input.transferId === null && input.splitCount === 1 && input.paymentCategoryId !== null && input.categoryId === input.paymentCategoryId;
}

/** One leg (one split of one transaction), as far as the workspace timeline cares. */
export interface TimelineLeg {
  /** Whether the leg's own account is on budget. */
  readonly onBudget: boolean;
  /** Whether the account at the other end of the transfer is on budget; `null` when the leg is not part of a transfer. */
  readonly transferPartnerOnBudget: boolean | null;
  /** Whether the leg is a credit card's own starting balance (`isStartingBalanceSplit`). */
  readonly startingBalance: boolean;
}

/**
 * Whether a leg counts on the budget month's own timeline (#659, domain expert's ruling): the
 * timeline is the net movement of every on-budget account, credit cards included, so
 *
 * - a leg on an off-budget account never counts;
 * - a transfer whose two ends are both on budget counts at neither end: a card payment, a
 *   transfer between two cash accounts and one between two cards only move money (or debt)
 *   inside the budget. A card purchase already counted when it was made, so paying it counts
 *   it no second time;
 * - a transfer with an off-budget account counts once, at its on-budget end;
 * - a card's starting balance does not count: it is the card's balance as of the day the account
 *   was added, not something that happened in the month.
 *
 * Summed over a month, the legs that count equal the change in on-budget cash less the change in
 * card debt, card starting balances left out.
 */
export function countsOnWorkspaceTimeline(leg: TimelineLeg): boolean {
  if (!leg.onBudget || leg.startingBalance) {
    return false;
  }
  return leg.transferPartnerOnBudget !== true;
}
