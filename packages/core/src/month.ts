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

/** Returns the following month: "2026-12" becomes "2027-01". */
export function nextMonth(month: Month): Month {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 12) {
    return `${year + 1}-01`;
  }
  return `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
}

/** Negative if a comes before b, zero if equal, positive if after. */
export function compareMonths(a: Month, b: Month): number {
  assertMonth(a);
  assertMonth(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every month from `from` to `to`, both included. Empty if `from` is after `to`. */
export function monthRange(from: Month, to: Month): Month[] {
  const months: Month[] = [];
  for (let current = from; compareMonths(current, to) <= 0; current = nextMonth(current)) {
    months.push(current);
  }
  return months;
}
