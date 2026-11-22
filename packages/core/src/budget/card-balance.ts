/**
 * A credit card's real, external balance, from its own account's transactions (#660, moved here
 * from `apps/api`'s budget repository so that the budget month can read the balance at the end of
 * every month it closes, and card-to-card transfers can read it too, #732).
 *
 * The balance is signed: positive is what is owed on the card, negative is a card in credit (it
 * was paid, or refunded, more than its whole balance). It counts every transaction of the card's
 * account dated up to the end of the month — the starting balance, purchases, refunds, payments,
 * transfers — whatever their day within the month, and never anything derived from the budget
 * (activity, card payments). A refund dated after today but inside the month already counts here,
 * while the budget counts it only from its date (#668): intended, see `docs/team/lessons.md`.
 */

import type { Cents } from "../money.ts";
import type { LocalDate, Month } from "../month.ts";
import { compareMonths, monthOf } from "../month.ts";

/** One transaction of a card's own account, as the account sees it: negative = a charge, positive = a payment or a refund. */
export interface CardTransaction {
  /** The transaction's day, in the workspace's time zone. */
  readonly date: LocalDate;
  /** The transaction's total (the sum of its splits), in the account's own sign. */
  readonly amount: Cents;
}

/**
 * What is owed on the card at the end of `month`: minus the sum of the card account's
 * transactions dated in `month` or before. Positive = owed, negative = the card is in credit.
 */
export function owedAsOf(transactions: readonly CardTransaction[], month: Month): Cents {
  let balance = 0;
  for (const transaction of transactions) {
    if (compareMonths(monthOf(transaction.date), month) > 0) continue;
    balance += transaction.amount;
  }
  // `0 - balance`, not `-balance`: a card with no transactions owes 0, never -0 (#699 returns it).
  return 0 - balance;
}
