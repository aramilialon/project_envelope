/**
 * Days of buffer (design.md, "Budget features" and "Numbers"): the
 * amount-weighted average number of days between a euro coming in and being
 * spent, first in first out, across every on-budget account treated as one
 * combined pool, over the outflows of the last 30 days. A transfer between
 * two on-budget accounts is neither an inflow nor an outflow of the pool:
 * the euro never left it. A transfer to or from an off-budget account is a
 * real inflow or outflow on the on-budget side, exactly like income or
 * spending.
 *
 * Pure, no database: every cash movement (income, spending, transfers) is
 * given directly; the caller derives it from transactions.
 */

import { assertCents, type Cents } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";

export interface BufferAccount {
  readonly id: string;
  readonly onBudget: boolean;
}

export interface CashMovement {
  readonly accountId: string;
  readonly date: LocalDate;
  /** Positive: money into the account. Negative: money out. */
  readonly amount: Cents;
  /** Set when this movement is one leg of a transfer; names the other leg's account. */
  readonly transferAccountId?: string;
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  const asUtc = (date: LocalDate): number =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((asUtc(to) - asUtc(from)) / 86_400_000);
}

interface QueuedInflow {
  readonly date: LocalDate;
  remaining: Cents;
}

/**
 * @throws ValidationError (via `assertDate`/`assertCents`) for an invalid date or amount.
 */
export function computeDaysOfBuffer(
  accounts: readonly BufferAccount[],
  movements: readonly CashMovement[],
  asOf: LocalDate,
): number {
  assertDate(asOf);
  const onBudgetById = new Map(accounts.map((a): [string, boolean] => [a.id, a.onBudget]));

  const pool = movements.filter((m) => {
    assertDate(m.date);
    assertCents(m.amount);
    if (!onBudgetById.get(m.accountId)) return false; // off-budget or unknown account
    if (m.transferAccountId !== undefined && onBudgetById.get(m.transferAccountId)) return false; // both legs on-budget
    return true;
  });

  const byDate = (a: { date: LocalDate }, b: { date: LocalDate }): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const inflows: QueuedInflow[] = pool
    .filter((m) => m.amount > 0)
    .map((m) => ({ date: m.date, remaining: m.amount }))
    .sort(byDate);
  const outflows = pool
    .filter((m) => m.amount < 0)
    .map((m) => ({ date: m.date, amount: -m.amount }))
    .sort(byDate);

  let queueIndex = 0;
  let weightedDays = 0;
  let windowAmount = 0;

  for (const outflow of outflows) {
    const age = daysBetween(outflow.date, asOf);
    const inWindow = age >= 0 && age < 30;
    let remainingToMatch = outflow.amount;

    while (remainingToMatch > 0) {
      const front = queueIndex < inflows.length ? inflows[queueIndex] : undefined;
      if (front === undefined || front.date > outflow.date) {
        // Nothing has arrived yet to cover this (a temporarily negative
        // balance): treat the gap as instant rather than guessing.
        if (inWindow) windowAmount += remainingToMatch;
        remainingToMatch = 0;
        break;
      }
      const consumed = Math.min(front.remaining, remainingToMatch);
      if (inWindow) {
        weightedDays += daysBetween(front.date, outflow.date) * consumed;
        windowAmount += consumed;
      }
      front.remaining -= consumed;
      remainingToMatch -= consumed;
      if (front.remaining === 0) queueIndex++;
    }
  }

  return windowAmount === 0 ? 0 : weightedDays / windowAmount;
}
