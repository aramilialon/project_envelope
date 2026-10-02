/**
 * Date helpers for `seed-demo.ts`, pulled into their own pure module so the rule they encode can
 * be unit-tested against an injected "today" instead of the real clock (`dates.test.ts`): every
 * *recorded* transaction's date is on or before today (never a future-dated "fact" that has not
 * happened yet), a scheduled transaction can genuinely be due before or after today, and a
 * pending transaction is recent (today or yesterday).
 */

export function monthOffset(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function daysIn(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export interface Today {
  readonly month: string;
  isoDate(offsetDays: number): string;
  /** A fixed day of the current month, clamped down to today when it would otherwise be in the future. */
  onOrBeforeToday(dayOfMonth: number): string;
  /**
   * A day before today, clamped to stay inside the current month — "near the start of the
   * month" otherwise has no such day at all, so this falls back to the last day of the previous
   * month instead (still genuinely before today, just not this month's own reservation).
   */
  beforeTodaySameMonth(daysBack: number): string;
  /** The mirror of `beforeTodaySameMonth`, falling forward into next month at the other edge. */
  afterTodaySameMonth(daysForward: number): string;
}

/** `now`/`timeZone` are parameters (not read from the system clock directly) so this is testable against any day of the month. */
export function todayAt(now: Date, timeZone: string): Today {
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const [year, month, day] = todayStr.split("-").map(Number) as [number, number, number];
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateOnDay = (d: number) => `${year}-${pad2(month)}-${pad2(d)}`;

  return {
    month: `${year}-${pad2(month)}`,
    isoDate(offsetDays: number) {
      const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
      return date.toISOString().slice(0, 10);
    },
    onOrBeforeToday(dayOfMonth: number) {
      return dateOnDay(Math.min(day, dayOfMonth));
    },
    beforeTodaySameMonth(daysBack: number) {
      const clampedDay = Math.max(1, day - daysBack);
      if (clampedDay >= day) {
        const date = new Date(Date.UTC(year, month - 1, 0)); // day 0 = previous month's last day
        return date.toISOString().slice(0, 10);
      }
      return dateOnDay(clampedDay);
    },
    afterTodaySameMonth(daysForward: number) {
      const clampedDay = Math.min(daysIn(year, month), day + daysForward);
      if (clampedDay <= day) {
        const date = new Date(Date.UTC(year, month, 1)); // next month's first day
        return date.toISOString().slice(0, 10);
      }
      return dateOnDay(clampedDay);
    },
  };
}
