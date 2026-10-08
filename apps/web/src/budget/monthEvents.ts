import type { TimelineEvent, TimelineEventStatus } from "@envelope/core";

import { currentMonthIn, todayIsoIn } from "../workspaceDate.ts";
import type { MonthEvent } from "./api.ts";

/** "September 2026" — the month heading/timeline label, shared by the budget month and the account register (`#337`). */
export function monthLabel(month: string, locale: string): string {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date);
}

/** A calendar month's own last day — `#326`, shared by the budget month's own timeline and the account register's (`#337`). */
export function daysInMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return new Date(year, monthNumber, 0).getDate();
}

/** Only set when the workspace's own time zone is known and `month` is the one actually showing on today's own calendar in it — otherwise there is no "today" line or overdue distinction to draw. */
export function todayOf(month: string, timeZone: string | undefined): { iso: string; day: number } | undefined {
  if (timeZone === undefined || month !== currentMonthIn(timeZone)) {
    return undefined;
  }
  const iso = todayIsoIn(timeZone);
  return { iso, day: Number(iso.slice(8, 10)) };
}

/** `GET .../budget-months/:month/events` into `computeTimeline`'s own input shape — shared by the budget month's own timeline (workspace-wide) and the account register's (one account's own, `?accountId=`, `#337`). */
export function toTimelineEvents(events: readonly MonthEvent[], today: { iso: string } | undefined): TimelineEvent[] {
  return events.map((e): TimelineEvent => {
    const direction = e.amountCents >= 0 ? "in" : "out";
    const status: TimelineEventStatus = e.kind !== "scheduled" ? "recorded" : today !== undefined && e.date < today.iso ? "overdue" : "scheduled";
    return { day: Number(e.date.slice(8, 10)), amountCents: Math.abs(e.amountCents), direction, status, payee: e.payee ?? "" };
  });
}
