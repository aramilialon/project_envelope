import type { Cents } from "../money.ts";

/**
 * The account register's own projected balance at the end of the month (design.md, "Account
 * register": "today's balance plus the scheduled transactions of the month that are not recorded
 * yet"). `notYetRecordedCents` is every scheduled transaction for this account, in this month,
 * signed the same way a real transaction's own total is (negative an outflow, positive an
 * inflow) — the budget month's own events endpoint already returns exactly these, tagged
 * `kind: "scheduled"`, whether overdue or still to come; both count here, only the timeline draws
 * them differently. Plain `Cents` out, no text (no user-facing text in `packages/core`) — `#333`'s
 * own header renders the figure this produces.
 */
export function computeProjectedBalance(currentBalanceCents: Cents, notYetRecordedCents: readonly Cents[]): Cents {
  return notYetRecordedCents.reduce((sum, c) => sum + c, currentBalanceCents);
}
