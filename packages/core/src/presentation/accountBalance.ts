import type { Cents } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";

/** One recorded row of an account, as far as its balance is concerned. */
export interface BalanceRow {
  /** The row's date in the workspace's time zone (a transaction's `budgetDate`). */
  readonly date: LocalDate;
  /** Signed: negative an outflow, positive an inflow. */
  readonly amountCents: Cents;
  /** True while the bank has not confirmed it yet; cleared and reconciled rows are not pending. */
  readonly pending: boolean;
}

/** A scheduled item of the account that is not recorded yet, signed like a recorded row. */
export interface NotYetRecordedAmount {
  readonly date: LocalDate;
  readonly amountCents: Cents;
}

export interface AccountBalance {
  /** Today's balance: every row dated on or before today. */
  readonly balanceCents: Cents;
  /** The part of today's balance the bank has confirmed (cleared and reconciled rows). */
  readonly clearedCents: Cents;
  /** The part of today's balance still pending. */
  readonly pendingCents: Cents;
  /** Today's balance, the rows dated after today up to the month end, and the month's scheduled items not recorded yet. */
  readonly projectedAtMonthEndCents: Cents;
}

/** Whether a row dated `date` has not happened yet on `today` (both in the workspace's time zone). */
export function isAfterToday(date: LocalDate, today: LocalDate): boolean {
  return date > today;
}

/**
 * An account's balances as of today (design.md, "Account register", #702), the one definition the
 * register, the Accounts screen, the accounts panel, a brokerage account's cash and the net worth
 * share:
 *
 * - the balance counts the rows dated on or before `today`; cleared and pending split those same
 *   rows, so they always add up to it;
 * - the projected balance at month end adds the rows dated after today up to the last day of
 *   today's month, and the scheduled items of this month not recorded yet, overdue ones of this
 *   month included;
 * - a row dated after the month end counts in no balance.
 *
 * `notYetRecorded` holds only scheduled items that have no recorded row: recording one with
 * "Record" advances its next date, so the recorded row replaces it and it is counted once. A
 * scheduled item entered again by hand as an ordinary transaction is not linked to it, so both
 * would count. Items dated in another month than today's are ignored. `today` and every date are `YYYY-MM-DD` in the workspace's time
 * zone, which is where the boundary between today and tomorrow is drawn.
 *
 * @throws ValidationError "invalid_date" if `today` is not a calendar date.
 */
export function computeAccountBalance(
  rows: readonly BalanceRow[],
  today: LocalDate,
  notYetRecorded: readonly NotYetRecordedAmount[] = [],
): AccountBalance {
  assertDate(today);
  const month = today.slice(0, 7);
  let balanceCents = 0;
  let pendingCents = 0;
  let laterThisMonthCents = 0;
  for (const row of rows) {
    if (!isAfterToday(row.date, today)) {
      balanceCents += row.amountCents;
      if (row.pending) {
        pendingCents += row.amountCents;
      }
    } else if (row.date.slice(0, 7) === month) {
      laterThisMonthCents += row.amountCents;
    }
  }
  const scheduledCents = notYetRecorded.filter((item) => item.date.slice(0, 7) === month).reduce((sum, item) => sum + item.amountCents, 0);
  return {
    balanceCents,
    clearedCents: balanceCents - pendingCents,
    pendingCents,
    projectedAtMonthEndCents: balanceCents + laterThisMonthCents + scheduledCents,
  };
}
