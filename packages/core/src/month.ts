/**
 * Budget months.
 *
 * The budget works by month, not by day. A month is the string "YYYY-MM",
 * for example "2026-09". Two months compare correctly as strings
 * ("2026-09" < "2026-10" < "2027-01") and are easy to read in tests and logs.
 */

import { ValidationError } from "./errors.ts";

/** A month in the "YYYY-MM" format. */
export type Month = string;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** @throws ValidationError with code "invalid_month". */
export function assertMonth(value: string): void {
  if (!MONTH_PATTERN.test(value)) {
    throw new ValidationError("invalid_month", `not a valid YYYY-MM month: "${value}"`, { value });
  }
}

/** Shifts a month by `delta` months, wrapping the year: `shiftMonth("2026-12", 1)` is "2027-01". */
export function shiftMonth(month: Month, delta: number): Month {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const totalMonths = year * 12 + (monthNumber - 1) + delta;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = ((totalMonths % 12) + 12) % 12;
  return `${String(newYear).padStart(4, "0")}-${String(newMonth + 1).padStart(2, "0")}`;
}

/** Negative if a comes before b, zero if equal, positive if after. */
export function compareMonths(a: Month, b: Month): number {
  assertMonth(a);
  assertMonth(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A calendar date in the "YYYY-MM-DD" format, already in the workspace's time zone. */
export type LocalDate = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @throws ValidationError with code "invalid_date" if the text is not a real calendar date. */
export function assertDate(value: string): void {
  const match = DATE_PATTERN.exec(value);
  const valid =
    match !== null &&
    (() => {
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    })();
  if (!valid) {
    throw new ValidationError("invalid_date", `not a valid YYYY-MM-DD date: "${value}"`, { value });
  }
}

/** The budget month a date belongs to: "2026-09-25" belongs to "2026-09". */
export function monthOf(date: LocalDate): Month {
  assertDate(date);
  return date.slice(0, 7);
}

/** Whole calendar days from `from` to `to` (negative if `to` comes first). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  assertDate(from);
  assertDate(to);
  const asUtc = (date: LocalDate): number =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((asUtc(to) - asUtc(from)) / 86_400_000);
}

/** Every month from `from` to `to`, both included. Empty if `from` is after `to`. */
export function monthRange(from: Month, to: Month): Month[] {
  const months: Month[] = [];
  for (let current = from; compareMonths(current, to) <= 0; current = shiftMonth(current, 1)) {
    months.push(current);
  }
  return months;
}

/** A scheduled transaction's own recurrence unit (design.md, "Scheduled transactions"). */
export type RecurUnit = "day" | "month" | "year";

function daysInCalendarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toLocalDate(year: number, month: number, day: number): LocalDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Advances a scheduled transaction's own `nextDueDate` forward by one recurrence step ("Record"
 * or "Skip", design.md's "Scheduled transactions") — never backward, `every` is always positive.
 * Calendar-aware for months and years: adding a month to "2026-01-31" lands on the last day of
 * February (28th or 29th), never rolling over into March the way naive date arithmetic would.
 */
export function advanceDate(date: LocalDate, every: number, unit: RecurUnit): LocalDate {
  assertDate(date);
  if (!Number.isInteger(every) || every <= 0) {
    throw new ValidationError("invalid_recurrence", "every must be a positive integer", { every: String(every) });
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  if (unit === "day") {
    const utc = Date.UTC(year, month - 1, day + every);
    const advanced = new Date(utc);
    return toLocalDate(advanced.getUTCFullYear(), advanced.getUTCMonth() + 1, advanced.getUTCDate());
  }

  const totalMonths = unit === "year" ? (year + every) * 12 + (month - 1) : year * 12 + (month - 1) + every;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  return toLocalDate(newYear, newMonth, Math.min(day, daysInCalendarMonth(newYear, newMonth)));
}

// --- Local days in a time zone ---------------------------------------------------

const SECOND = 1_000;
const HOUR = 3_600_000;

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new ValidationError("invalid_time_zone", `"${timeZone}" is not a known IANA time zone`, { timeZone });
    }
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock's reading at the instant `ms` in `timeZone`, read as if it were UTC, in ms. */
function wallClockAt(ms: number, timeZone: string): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

const startOfDayCache = new Map<string, string>();

/**
 * The first instant of the calendar date `date` in `timeZone`, as an ISO 8601 UTC timestamp: its
 * local midnight ("2026-07-10" in Europe/Rome is "2026-07-09T22:00:00.000Z", in winter one hour
 * later). Where the clocks skip midnight (a daylight saving change at 00:00), the day starts when
 * they jump; where midnight comes twice (clocks going back across it), at the first one.
 *
 * @throws ValidationError "invalid_date" for a malformed date, "invalid_time_zone" for a time zone
 *   the runtime does not know.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): string {
  assertDate(date);
  const key = `${timeZone} ${date}`;
  const cached = startOfDayCache.get(key);
  if (cached !== undefined) return cached;

  // The wall clock's midnight read as UTC; every offset in use is within ±15 hours, and the offsets
  // in force from a day and a half before to a day and a half after give every candidate instant.
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = midnight + hours * HOUR;
    offsets.add(wallClockAt(probe, timeZone) - probe);
  }
  const candidates = [...offsets].map((offset) => midnight - offset).sort((a, b) => a - b);
  // An instant whose wall clock reads exactly midnight: the earliest one.
  let start = candidates.find((instant) => wallClockAt(instant, timeZone) === midnight);
  if (start === undefined) {
    // Midnight does not exist on this date: the day starts at the jump, between the last candidate
    // still on the day before and the first one already past midnight.
    let high = candidates.find((instant) => wallClockAt(instant, timeZone) > midnight)!;
    let low = candidates.filter((instant) => instant < high).at(-1)!;
    while (high - low > SECOND) {
      const middle = low + Math.floor((high - low) / 2 / SECOND) * SECOND;
      if (wallClockAt(middle, timeZone) >= midnight) high = middle;
      else low = middle;
    }
    start = high;
  }
  const iso = new Date(start).toISOString();
  if (startOfDayCache.size >= 10_000) startOfDayCache.clear();
  startOfDayCache.set(key, iso);
  return iso;
}
