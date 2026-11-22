/**
 * Returns of a portfolio over a period (design.md, "Portfolio module"; domain
 * guide, "Flows, valuation and returns"). Returns are after costs and taxes.
 *
 * Generic over two inputs, both in one currency (the caller converts each
 * flow at its own date's rate and each value at its valuation date's rate):
 *
 * - `ExternalFlow`: money moved into (+) or out of (−) the portfolio on a
 *   date, as `externalFlows` derives it from trades. Flows happen at the end
 *   of their day: a value on that date already includes them.
 * - `Valuation`: the portfolio's market value at the end of a date, or null
 *   when it is unknown (a price is missing). Unknown is never 0.
 *
 * Two figures:
 *
 * - **Time-weighted return** (`timeWeightedReturn`), true time-weighted, not
 *   Modified Dietz: the period is cut at the end of every day with a flow and
 *   at every valuation the caller adds (each month end), each sub-period's
 *   return is r = (V_b − F_b) ÷ V_a − 1 (V_a the value at its start, V_b at its
 *   end, F_b the flows of its last day), or V_b ÷ F_b − 1 when it starts from
 *   nothing (V_a = 0, a first buy), and the sub-periods are linked:
 *   Π(1 + r) − 1. A sub-period with no value and no flow contributes 0.
 * - **Money-weighted return** (`moneyWeightedReturn`, XIRR): the rate that
 *   brings the household's own flows to zero (the opposite of the
 *   portfolio's, the start value paid in on the start date and the end value
 *   received on the end date), Actual/365, found by bisection between −99%
 *   and +1000% a year.
 *
 * A period of 365 days or more gives a yearly figure (`annualized: true`);
 * a shorter one gives the return over the period itself. The length runs
 * from the first date with money in the portfolio (the start value, or the
 * first flow when the start value is 0) to the end.
 *
 * Computed in double precision from integer minor units, in a fixed order,
 * and rounded once to millionths (`returnE6`, half away from zero): 26694 is
 * 2.6694%. A return is never stored.
 *
 * Pure: no database and no user-facing text (ADR 0004).
 */

import { ValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import { assertCents } from "../money.ts";
import type { LocalDate } from "../month.ts";
import { assertDate, daysBetween } from "../month.ts";

/** Money moved into (+) or out of (−) a portfolio at the end of `date`; null when it is unknown. */
export interface ExternalFlow {
  readonly date: LocalDate;
  readonly amountCents: Cents | null;
}

/** A portfolio's value at the end of `date`; null when it is unknown (never 0 for unknown). */
export interface Valuation {
  readonly date: LocalDate;
  readonly valueCents: Cents | null;
}

/**
 * Why a return cannot be computed:
 * - "missing_value": a value or a flow it needs is unknown;
 * - "no_capital": there was never money in the portfolio, or a sub-period
 *   ends with more taken out than it holds (V_b − F_b < 0), or a value
 *   appears from no money at all;
 * - "no_solution": no rate between −99% and +1000% a year balances the
 *   flows (money-weighted only).
 */
export type UnknownReturnReason = "missing_value" | "no_capital" | "no_solution";

/**
 * A return, in millionths (`returnE6`: 10000 is 1.00%), or why it is unknown.
 * `annualized` is true when the figure is a yearly rate (a period of 365 days
 * or more) and false when it is the return over the period itself.
 */
export type ReturnOutcome =
  | { readonly status: "known"; readonly returnE6: number; readonly annualized: boolean }
  | { readonly status: "unknown"; readonly reason: UnknownReturnReason };

/** A return before it is rounded: `rate` as a double (0.01 is 1%). */
export type RateOutcome =
  | { readonly status: "known"; readonly rate: number; readonly annualized: boolean }
  | { readonly status: "unknown"; readonly reason: UnknownReturnReason };

/** A period of this many days or more gives a yearly figure. */
export const DAYS_PER_YEAR = 365;

/** The bisection bounds of the money-weighted return, as yearly rates. */
const MWR_LOW = -0.99;
const MWR_HIGH = 10;

export interface TimeWeightedInput {
  /** The value at the end of the day before the period: 0 when the portfolio starts within it. */
  readonly start: Valuation;
  /**
   * The values the period is cut at, after `start`, in date order: one on every
   * date that has a flow, plus any other date wanted (each month end). The last
   * one ends the period.
   */
  readonly valuations: readonly Valuation[];
  /** The flows after `start` up to the last valuation, in any order; several on one date add up. */
  readonly flows: readonly ExternalFlow[];
}

/**
 * The true time-weighted return over a period (see the module comment).
 *
 * @throws ValidationError "invalid_date" (details: value) for a malformed
 *   date, valuations not strictly after `start` and in increasing date order,
 *   no valuation at all, or a flow outside the period or on a date with no
 *   valuation; "invalid_amount" (details: label, value) for an amount that is
 *   not a safe integer or a negative value.
 */
export function timeWeightedReturn(input: TimeWeightedInput): ReturnOutcome {
  return rounded(timeWeightedRate(input));
}

/** `timeWeightedReturn` before rounding: the rate as a double, for tests and for callers that link further. */
export function timeWeightedRate(input: TimeWeightedInput): RateOutcome {
  checkValuation(input.start);
  let previous = input.start.date;
  for (const valuation of input.valuations) {
    checkValuation(valuation);
    if (valuation.date <= previous) invalidDate(valuation.date, "valuations must follow the start in increasing date order");
    previous = valuation.date;
  }
  const end = input.valuations.at(-1);
  if (end === undefined) invalidDate(input.start.date, "a period needs at least one valuation after its start");
  const valuationDates = new Set(input.valuations.map((valuation) => valuation.date));
  const daily = flowsByDate(input.flows, input.start.date, end.date);
  for (const date of daily.keys()) {
    if (!valuationDates.has(date)) invalidDate(date, "every date with a flow needs a valuation");
  }

  if (input.start.valueCents === null || input.valuations.some((valuation) => valuation.valueCents === null)) return unknown("missing_value");
  if ([...daily.values()].some((amount) => amount === null)) return unknown("missing_value");

  let growth = 1;
  let invested = false;
  let valueBefore: Cents = input.start.valueCents;
  for (const valuation of input.valuations) {
    const valueAfter = valuation.valueCents as Cents;
    const flow = daily.get(valuation.date) ?? 0;
    if (flow === null) return unknown("missing_value");
    let factor: number;
    if (valueBefore > 0) {
      if (valueAfter - flow < 0) return unknown("no_capital");
      factor = (valueAfter - flow) / valueBefore;
    } else if (flow > 0) {
      factor = valueAfter / flow;
    } else if (flow === 0 && valueAfter === 0) {
      factor = 1;
    } else {
      return unknown("no_capital");
    }
    if (valueBefore > 0 || flow > 0) invested = true;
    growth *= factor;
    valueBefore = valueAfter;
  }
  if (!invested) return unknown("no_capital");

  const days = daysBetween(firstInvestedDate(input.start, daily), end.date);
  if (days >= DAYS_PER_YEAR) return known(Math.pow(growth, DAYS_PER_YEAR / days) - 1, true);
  return known(growth - 1, false);
}

export interface MoneyWeightedInput {
  /** The value at the end of the start date, paid in on that date: 0 when the portfolio starts within the period. */
  readonly start: Valuation;
  /** The value at the end of the period, received on its date. */
  readonly end: Valuation;
  /** The flows after `start` up to `end`, in any order; several on one date add up. */
  readonly flows: readonly ExternalFlow[];
}

/**
 * The money-weighted return (XIRR) over a period (see the module comment):
 * a yearly rate for 365 days or more, otherwise (1 + r)^(days ÷ 365) − 1.
 *
 * @throws ValidationError "invalid_date" (details: value) for a malformed
 *   date, an end not after the start, or a flow outside the period;
 *   "invalid_amount" (details: label, value) for an amount that is not a safe
 *   integer or a negative value.
 */
export function moneyWeightedReturn(input: MoneyWeightedInput): ReturnOutcome {
  return rounded(moneyWeightedRate(input));
}

/** `moneyWeightedReturn` before rounding: the rate as a double, for tests. */
export function moneyWeightedRate(input: MoneyWeightedInput): RateOutcome {
  checkValuation(input.start);
  checkValuation(input.end);
  if (input.end.date <= input.start.date) invalidDate(input.end.date, "the end must follow the start");
  const daily = flowsByDate(input.flows, input.start.date, input.end.date);

  if (input.start.valueCents === null || input.end.valueCents === null) return unknown("missing_value");
  if ([...daily.values()].some((amount) => amount === null)) return unknown("missing_value");

  // The household's side: what it pays in is negative, what it gets back positive.
  const household = new Map<LocalDate, Cents>();
  const add = (date: LocalDate, amount: Cents): void => {
    const total = (household.get(date) ?? 0) + amount;
    assertCents(total, "flow");
    household.set(date, total);
  };
  if (input.start.valueCents !== 0) add(input.start.date, -input.start.valueCents);
  for (const [date, amount] of daily) add(date, -(amount as Cents));
  add(input.end.date, input.end.valueCents);

  const cashFlows = [...household].filter(([, amount]) => amount !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const first = cashFlows[0];
  if (first === undefined || !cashFlows.some(([, amount]) => amount < 0)) return unknown("no_capital");
  const timed = cashFlows.map(([date, amount]) => ({ years: daysBetween(first[0], date) / DAYS_PER_YEAR, amount }));
  const days = daysBetween(first[0], input.end.date);

  const rate = bisect((r) => timed.reduce((total, flow) => total + flow.amount * Math.pow(1 + r, -flow.years), 0));
  if (rate === null) return unknown("no_solution");
  if (days >= DAYS_PER_YEAR) return known(rate, true);
  return known(Math.pow(1 + rate, days / DAYS_PER_YEAR) - 1, false);
}

/** A root of `f` between `MWR_LOW` and `MWR_HIGH`, or null if `f` does not change sign there. */
function bisect(f: (rate: number) => number): number | null {
  let low = MWR_LOW;
  let high = MWR_HIGH;
  let fLow = f(low);
  const fHigh = f(high);
  if (fLow === 0) return low;
  if (fHigh === 0) return high;
  if (Math.sign(fLow) === Math.sign(fHigh) || Number.isNaN(fLow) || Number.isNaN(fHigh)) return null;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (middle === low || middle === high) break;
    const fMiddle = f(middle);
    if (fMiddle === 0) return middle;
    if (Math.sign(fMiddle) === Math.sign(fLow)) {
      low = middle;
      fLow = fMiddle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

/**
 * The flows after `start` and up to `end` added up by date, a date's total
 * null when any of its flows is unknown.
 */
function flowsByDate(flows: readonly ExternalFlow[], start: LocalDate, end: LocalDate): Map<LocalDate, Cents | null> {
  const daily = new Map<LocalDate, Cents | null>();
  for (const flow of flows) {
    assertDate(flow.date);
    if (flow.date <= start || flow.date > end) invalidDate(flow.date, "a flow falls outside the period");
    if (flow.amountCents !== null) assertCents(flow.amountCents, "flow");
    const total = daily.has(flow.date) ? daily.get(flow.date) ?? null : 0;
    if (total === null || flow.amountCents === null) {
      daily.set(flow.date, null);
    } else {
      const sum = total + flow.amountCents;
      assertCents(sum, "flow");
      daily.set(flow.date, sum);
    }
  }
  return daily;
}

/** The first date with money in the portfolio: the start, or the first non-zero flow when the start value is 0. */
function firstInvestedDate(start: Valuation, daily: ReadonlyMap<LocalDate, Cents | null>): LocalDate {
  if (start.valueCents !== 0) return start.date;
  const dates = [...daily].filter(([, amount]) => amount !== 0).map(([date]) => date).sort();
  return dates[0] ?? start.date;
}

function checkValuation(valuation: Valuation): void {
  assertDate(valuation.date);
  if (valuation.valueCents === null) return;
  assertCents(valuation.valueCents, "value");
  if (valuation.valueCents < 0) {
    throw new ValidationError("invalid_amount", `a value cannot be negative: ${valuation.valueCents}`, {
      label: "value",
      value: String(valuation.valueCents),
    });
  }
}

function invalidDate(value: LocalDate, message: string): never {
  throw new ValidationError("invalid_date", message, { value });
}

function unknown(reason: UnknownReturnReason): RateOutcome {
  return { status: "unknown", reason };
}

function known(rate: number, annualized: boolean): RateOutcome {
  return { status: "known", rate, annualized };
}

/** Rounds a rate once to millionths, half away from zero (never −0). */
function rounded(outcome: RateOutcome): ReturnOutcome {
  if (outcome.status === "unknown") return outcome;
  const scaled = outcome.rate * 1_000_000;
  const value = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return { status: "known", returnE6: value === 0 ? 0 : value, annualized: outcome.annualized };
}
