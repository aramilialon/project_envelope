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
 *   Π(1 + r) − 1. A sub-period with nothing held at either end (V_a = 0 and
 *   V_b = 0) contributes 0 whatever its flows: money that moves while the
 *   portfolio holds nothing (a dividend after the last sale, a fee before
 *   the first buy) is left out of the TWR, which measures the holdings.
 * - **Money-weighted return** (`moneyWeightedReturn`, XIRR): the rate that
 *   brings the household's own flows to zero (the opposite of the
 *   portfolio's, the start value paid in on the start date and the end value
 *   received on the end date), each flow timed by `yearFraction` from the
 *   first one, found by bisection. The bounds apply to the figure shown:
 *   the yearly rate for a period of a year or more, the period's own rate
 *   for a shorter one, from just above −100% to +1000%. With several sign
 *   changes there can be several rates; the figure is the one bisection
 *   finds from those bounds, deterministically. Nothing ever received back
 *   is exactly −100%. When the end value is 0 the period ends at the last
 *   money received, since XIRR assumes money stays invested at its rate.
 *
 * A period that reaches its first anniversary (`yearFraction` ≥ 1) gives a
 * yearly figure (`annualized: true`); a shorter one gives the return over
 * the period itself. For the TWR the period starts on the start date when
 * the start value is above 0, otherwise on the first valuation above 0; for
 * the MWR on the household's first flow.
 *
 * Computed in double precision from integer minor units, in a fixed order,
 * and rounded once to millionths (`returnE6`, half away from zero): 26694 is
 * 2.6694%. `returnE6` is the figure: a screen rounds `returnE6` itself to
 * 0.01 percentage points, half to even, never the double. A return is never
 * stored; link unrounded `…Rate`s (or make one call), never rounded figures.
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
 * - "no_solution": no rate from just above −100% to +1000% (of the figure shown) balances the
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

/** The bisection bounds of the money-weighted return, on the figure shown: just above −100% to +1000%. */
const MWR_LOW = -1 + 1e-12;
const MWR_HIGH = 10;

/**
 * Years from `from` to `to` by calendar anniversaries: the whole
 * anniversaries n, plus the days since the n-th ÷ the days from the n-th to
 * the (n+1)-th. A 29 February anniversary falls on 28 February in a year
 * that is not a leap year. 1 January → 1 July 2025 is 181/365, 1 January →
 * 1 July 2024 182/366, 31 December 2022 → 31 December 2024 exactly 2.
 *
 * @throws ValidationError "invalid_date" (details: value) for a malformed
 *   date or `to` before `from`.
 */
export function yearFraction(from: LocalDate, to: LocalDate): number {
  assertDate(from);
  assertDate(to);
  if (to < from) invalidDate(to, "the end must not come before the start");
  let whole = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  if (anniversary(from, whole) > to) whole -= 1;
  const last = anniversary(from, whole);
  return whole + daysBetween(last, to) / daysBetween(last, anniversary(from, whole + 1));
}

/** `date` moved `years` years on, 29 February becoming 28 February outside a leap year. */
function anniversary(date: LocalDate, years: number): LocalDate {
  const year = Number(date.slice(0, 4)) + years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDay = date.slice(5) === "02-29" && !leap ? "02-28" : date.slice(5);
  return `${String(year).padStart(4, "0")}-${monthDay}`;
}

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
    // Never null here: unknown flows were turned away above.
    const flow = daily.get(valuation.date) ?? 0;
    let factor: number;
    if (valueBefore > 0) {
      if (valueAfter - flow < 0) return unknown("no_capital");
      factor = (valueAfter - flow) / valueBefore;
    } else if (valueAfter === 0) {
      // Nothing held at either end: the flows are left out of the TWR.
      factor = 1;
    } else if (flow > 0) {
      factor = valueAfter / flow;
    } else {
      return unknown("no_capital");
    }
    if (valueBefore > 0 || valueAfter > 0) invested = true;
    growth *= factor;
    valueBefore = valueAfter;
  }
  if (!invested) return unknown("no_capital");

  const years = yearFraction(firstHeldDate(input.start, input.valuations), end.date);
  if (years >= 1) return known(Math.pow(growth, 1 / years) - 1, true);
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
 * a yearly rate for a period of a year or more, otherwise the period's own
 * rate R, each flow discounted by (1 + R)^(−t ÷ T), t its time from the first
 * flow and T the period's, both in years.
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
  const last = cashFlows.at(-1);
  if (first === undefined || last === undefined || !cashFlows.some(([, amount]) => amount < 0)) return unknown("no_capital");
  const origin = first[0];
  // Nothing ever received back: a total loss, outside any bounds.
  if (!cashFlows.some(([, amount]) => amount > 0)) return known(-1, yearFraction(origin, input.end.date) >= 1);

  // The period ends on the end date, or at the last money received when the end value is 0.
  const period = yearFraction(origin, last[0]);
  const annualized = period >= 1;
  // Each flow's exponent in the unit of the figure shown: years, or fractions of the period.
  const unit = annualized ? 1 : period;
  // Future values at the period's end, so every exponent is ≥ 0 and nothing overflows near −100%.
  const timed = cashFlows.map(([date, amount]) => ({ exponent: (period - yearFraction(origin, date)) / unit, amount }));
  const rate = bisect((r) => timed.reduce((total, flow) => total + flow.amount * Math.pow(1 + r, flow.exponent), 0));
  if (rate === null) return unknown("no_solution");
  return known(rate, annualized);
}

/** A root of `f` between `MWR_LOW` and `MWR_HIGH` (the one bisection finds from them), or null if `f` does not change sign there. */
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

/** Where the TWR's clock starts: the start when it holds something, else the first valuation above 0. */
function firstHeldDate(start: Valuation, valuations: readonly Valuation[]): LocalDate {
  if (start.valueCents !== null && start.valueCents > 0) return start.date;
  return valuations.find((valuation) => valuation.valueCents !== null && valuation.valueCents > 0)?.date ?? start.date;
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
