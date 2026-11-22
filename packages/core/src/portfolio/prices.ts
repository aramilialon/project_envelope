/**
 * Which stored price values an instrument on a date (ADR 0019, "Precedence").
 *
 * An instrument can have two kinds of prices: a shared one, fetched from a
 * provider and the same for every workspace, and the workspace's own, typed
 * or imported by a user. The caller loads both kinds for one instrument, as
 * candidates; the rule that picks one lives here, not in SQL:
 *
 * - the price is the candidate with the latest date on or before the date
 *   asked for;
 * - on the same date, the workspace's own price wins over the shared one;
 * - no candidate on or before the date means the price is unknown (`null`),
 *   never zero.
 */

import { ValidationError } from "../errors.ts";
import type { LocalDate } from "../month.ts";
import { assertDate } from "../month.ts";
import type { Price } from "./quantity.ts";
import { assertPrice } from "./quantity.ts";

/** `own`: the workspace's own price (manual or CSV); `shared`: a provider's price. */
export type PriceOrigin = "own" | "shared";

/** One stored closing price of an instrument. `closeE6` is quoted like a trade's price (ADR 0011). */
export interface PriceCandidate {
  readonly priceDate: LocalDate;
  readonly closeE6: Price;
  readonly origin: PriceOrigin;
}

/** The price that values an instrument on a date, and where it came from. */
export interface ResolvedPrice {
  readonly closeE6: Price;
  /** The date of the price used: on or before the date asked for. */
  readonly priceDate: LocalDate;
  readonly origin: PriceOrigin;
}

/**
 * The candidates in the order the rule prefers them, after checking each one:
 * by date, and on the same date the shared one before the own one, so that the
 * last candidate on or before a date is the one that wins.
 *
 * @throws ValidationError `invalid_date` or `invalid_price` for a malformed
 *   candidate, `duplicate_price` for two candidates of the same origin on the
 *   same date (the table allows one of each).
 */
function ordered(candidates: readonly PriceCandidate[]): PriceCandidate[] {
  for (const candidate of candidates) {
    assertDate(candidate.priceDate);
    assertPrice(candidate.closeE6, "closeE6");
  }
  const sorted = [...candidates].sort(
    (a, b) => compareDates(a.priceDate, b.priceDate) || originRank(a.origin) - originRank(b.origin),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.priceDate === current.priceDate && previous.origin === current.origin) {
      throw new ValidationError("duplicate_price", `two ${current.origin} prices on ${current.priceDate}`, {
        date: current.priceDate,
        origin: current.origin,
      });
    }
  }
  return sorted;
}

function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Shared first, so the workspace's own price on the same date comes after it and wins. */
function originRank(origin: PriceOrigin): number {
  return origin === "shared" ? 0 : 1;
}

function toResolved(candidate: PriceCandidate): ResolvedPrice {
  return { closeE6: candidate.closeE6, priceDate: candidate.priceDate, origin: candidate.origin };
}

/**
 * The price of one instrument on `date`, from its candidates (shared and own,
 * in any order), or `null` when none is dated on or before it.
 *
 * @throws ValidationError `invalid_date` for a malformed `date`, and see
 *   {@link ordered} for the candidates.
 */
export function resolvePrice(candidates: readonly PriceCandidate[], date: LocalDate): ResolvedPrice | null {
  assertDate(date);
  let found: PriceCandidate | null = null;
  for (const candidate of ordered(candidates)) {
    if (candidate.priceDate > date) {
      break;
    }
    found = candidate;
  }
  return found === null ? null : toResolved(found);
}

/**
 * The price of one instrument on each of `dates`, in the order given: the same
 * rule as {@link resolvePrice}, with the candidates sorted once.
 *
 * @throws ValidationError `invalid_date` for a malformed date, and see
 *   {@link ordered} for the candidates.
 */
export function priceSeriesAt(candidates: readonly PriceCandidate[], dates: readonly LocalDate[]): (ResolvedPrice | null)[] {
  for (const date of dates) {
    assertDate(date);
  }
  const sorted = ordered(candidates);
  const order = dates.map((date, index) => ({ date, index })).sort((a, b) => compareDates(a.date, b.date));
  const result: (ResolvedPrice | null)[] = dates.map(() => null);
  let next = 0;
  let found: PriceCandidate | null = null;
  for (const { date, index } of order) {
    while (next < sorted.length && sorted[next]!.priceDate <= date) {
      found = sorted[next]!;
      next += 1;
    }
    result[index] = found === null ? null : toResolved(found);
  }
  return result;
}
