/**
 * "Today" and "this month", in a workspace's own time zone (#326) — never the browser's, which
 * can disagree with it (a different zone entirely, or simply past midnight in one but not yet in
 * the other) and would then show the wrong "today" line on the budget month's timeline, or group
 * the account register's own last transaction under the wrong day heading. The single source of
 * truth both screens share, replacing two separate, browser-local `todayIso()` functions.
 */

/** `YYYY-MM-DD`, in `timeZone` — `en-CA`'s own date formatting is already that shape, so no manual assembly from parts is needed. */
export function todayIsoIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** `YYYY-MM`, in `timeZone`. */
export function currentMonthIn(timeZone: string): string {
  return todayIsoIn(timeZone).slice(0, 7);
}
