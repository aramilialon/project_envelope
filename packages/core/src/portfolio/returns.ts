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
 *   first one. The bounds apply to the figure shown: the yearly rate for a
 *   period of a year or more, the period's own rate for a shorter one, from
 *   just above −100% to +1000%. With several sign changes there can be
 *   several rates; the figure is the one nearest 0, found by scanning
 *   outward from 0 for the first sign change and bisecting there. Nothing
 *   received back after money was paid in is exactly −100%. The period ends
 *   at the last money received, since XIRR assumes money stays invested at
 *   its rate: a payment after it (a fee after the final sale) is discounted
 *   back to it. A period of no length (nothing held at the start and every
 *   flow on the end date, a first buy on the end date itself) is the end
 *   value ÷ that day's net flow − 1, the same as the TWR.
 *
 * **Nothing held.** Both returns first check that the period held capital:
 * a value above 0 at the end of at least one day it is valued on (its
 * start, every day with a flow, every month end the caller adds, its end).
 * When none is, both are unknown: `missing_value` if one of those values is
 * unknown, otherwise `no_capital`. A period worth nothing at the end of
 * every such day has no return, only a gain (domain expert, #89).
 *
 * A period that reaches its first anniversary (`yearFraction` ≥ 1) gives a
 * yearly figure (`annualized: true`); a shorter one gives the return over
 * the period itself. The TWR's clock runs only while something is held:
 * from the start date, or the first day ending with a value above 0, to the
 * next day the value is back to 0, stretch by stretch, the stretches'
 * `yearFraction`s added up. The MWR's runs from the household's first flow
 * to the last money received.
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
 * - "no_capital": nothing held at the end of any day the period is valued
 *   on (start, flow dates, month ends, end), or a sub-period ends with more
 *   taken out than it holds, or a value appears from no money at all;
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

/** The bounds of the money-weighted return, on the figure shown: just above −100% to +1000%. */
const MWR_LOW = -1 + 1e-12;
const MWR_HIGH = 10;
/**
 * The scan for the root nearest 0 steps in ln(1 + rate), so it approaches
 * −100% geometrically: the first step, and the factor each step grows by.
 */
const SCAN_FIRST_STEP = 1e-4;
const SCAN_GROWTH = 1.5;

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

  const held = heldCheck([input.start, ...input.valuations]);
  if (held !== null) return held;
  if (input.start.valueCents === null || input.valuations.some((valuation) => valuation.valueCents === null)) return unknown("missing_value");
  if ([...daily.values()].some((amount) => amount === null)) return unknown("missing_value");

  let growth = 1;
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
    growth *= factor;
    valueBefore = valueAfter;
  }

  const years = heldYears(input.start, input.valuations);
  if (years >= 1) return known(Math.pow(growth, 1 / years) - 1, true);
  return known(growth - 1, false);
}

export interface MoneyWeightedInput {
  /** The value at the end of the start date, paid in on that date: 0 when the portfolio starts within the period. */
  readonly start: Valuation;
  /** The value at the end of the period, received on its date. */
  readonly end: Valuation;
  /**
   * The values at the end of every date with a flow, plus any other date
   * valued (each month end), after `start` and up to `end`, in date order: the
   * same cuts as the TWR's. They decide whether the period held capital; one
   * on the end date must equal `end`.
   */
  readonly valuations: readonly Valuation[];
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
 *   date, an end not after the start, valuations not strictly after `start`,
 *   in increasing date order and up to `end`, or a flow outside the period or
 *   on a date with no valuation (other than the end date); "invalid_amount"
 *   (details: label, value) for an amount that is not a safe integer, a
 *   negative value, or a valuation on the end date that differs from `end`.
 */
export function moneyWeightedReturn(input: MoneyWeightedInput): ReturnOutcome {
  return rounded(moneyWeightedRate(input));
}

/** `moneyWeightedReturn` before rounding: the rate as a double, for tests. */
export function moneyWeightedRate(input: MoneyWeightedInput): RateOutcome {
  checkValuation(input.start);
  checkValuation(input.end);
  if (input.end.date <= input.start.date) invalidDate(input.end.date, "the end must follow the start");
  let previous = input.start.date;
  for (const valuation of input.valuations) {
    checkValuation(valuation);
    if (valuation.date <= previous) invalidDate(valuation.date, "valuations must follow the start in increasing date order");
    if (valuation.date > input.end.date) invalidDate(valuation.date, "a valuation falls after the end");
    if (valuation.date === input.end.date && valuation.valueCents !== input.end.valueCents) {
      throw new ValidationError("invalid_amount", "a valuation on the end date must equal the end value", {
        label: "value",
        value: String(valuation.valueCents),
      });
    }
    previous = valuation.date;
  }
  const valuationDates = new Set([...input.valuations.map((valuation) => valuation.date), input.end.date]);
  const daily = flowsByDate(input.flows, input.start.date, input.end.date);
  for (const date of daily.keys()) {
    if (!valuationDates.has(date)) invalidDate(date, "every date with a flow needs a valuation");
  }

  // 1. Nothing held at the end of any day the period is valued on: no return.
  const held = heldCheck([input.start, ...input.valuations, input.end]);
  if (held !== null) return held;
  if (input.start.valueCents === null || input.end.valueCents === null) return unknown("missing_value");
  if ([...daily.values()].some((amount) => amount === null)) return unknown("missing_value");
  const endValue = input.end.valueCents;

  // 2. A period of no length: nothing held at the start, every flow on the end date (a first buy today).
  if (input.start.valueCents === 0 && [...daily.keys()].every((date) => date === input.end.date)) {
    const flow = daily.get(input.end.date) ?? 0;
    if (flow === null || flow <= 0) return unknown("no_capital");
    return known(endValue / flow - 1, false);
  }

  // The household's side: what it pays in is negative, what it gets back positive.
  const household = new Map<LocalDate, Cents>();
  const add = (date: LocalDate, amount: Cents): void => {
    const total = (household.get(date) ?? 0) + amount;
    assertCents(total, "flow");
    household.set(date, total);
  };
  if (input.start.valueCents !== 0) add(input.start.date, -input.start.valueCents);
  for (const [date, amount] of daily) add(date, -(amount as Cents));
  add(input.end.date, endValue);

  const cashFlows = [...household].filter(([, amount]) => amount !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const firstPaid = cashFlows.findIndex(([, amount]) => amount < 0);
  const first = cashFlows[0];
  if (first === undefined || firstPaid === -1) return unknown("no_capital");
  const origin = first[0];
  // 3. Nothing received back after money was paid in: a total loss, outside any bounds.
  const lastReceived = cashFlows.findLast(([, amount]) => amount > 0);
  if (lastReceived === undefined || cashFlows.indexOf(lastReceived) < firstPaid) {
    return known(-1, yearFraction(origin, input.end.date) >= 1);
  }

  // 4. The period ends at the last money received; a payment after it is discounted back to it.
  const period = yearFraction(origin, lastReceived[0]);
  const annualized = period >= 1;
  // Each flow's exponent in the unit of the figure shown: years, or fractions of the period.
  const unit = annualized ? 1 : period;
  // Values at the period's end: every exponent but those of later payments is ≥ 0.
  const timed = cashFlows.map(([date, amount]) => ({
    exponent: date <= lastReceived[0] ? (period - yearFraction(origin, date)) / unit : -yearFraction(lastReceived[0], date) / unit,
    amount,
  }));
  // 5. The root nearest 0.
  const rate = nearestRoot((r) => timed.reduce((total, flow) => total + flow.amount * Math.pow(1 + r, flow.exponent), 0));
  if (rate === null) return unknown("no_solution");
  return known(rate, annualized);
}

/**
 * The root of `f` nearest 0 between `MWR_LOW` and `MWR_HIGH`, or null if `f`
 * does not change sign there: steps outward from 0 on both sides, in
 * ln(1 + rate) with growing steps (the side below 0 first at each step, as
 * it is the nearer one), until a step brackets a change of sign, then
 * bisects that step. It never evaluates nearer −100% than the bracket it
 * needs, where a later payment's negative exponent would overflow.
 */
function nearestRoot(f: (rate: number) => number): number | null {
  const atZero = f(0);
  if (atZero === 0) return 0;
  if (Number.isNaN(atZero)) return null;
  const lowLog = Math.log1p(MWR_LOW);
  const highLog = Math.log1p(MWR_HIGH);
  let below = { rate: 0, value: atZero };
  let above = { rate: 0, value: atZero };
  let belowDone = false;
  let aboveDone = false;
  for (let distance = SCAN_FIRST_STEP; !(belowDone && aboveDone); distance *= SCAN_GROWTH) {
    if (!belowDone) {
      const rate = -distance <= lowLog ? MWR_LOW : Math.expm1(-distance);
      const value = f(rate);
      if (Number.isNaN(value)) {
        belowDone = true;
      } else {
        if (value === 0) return rate;
        if (Math.sign(value) !== Math.sign(below.value)) return bisect(f, rate, below.rate, value);
        below = { rate, value };
        if (rate === MWR_LOW) belowDone = true;
      }
    }
    if (!aboveDone) {
      const rate = distance >= highLog ? MWR_HIGH : Math.expm1(distance);
      const value = f(rate);
      if (Number.isNaN(value)) {
        aboveDone = true;
      } else {
        if (value === 0) return rate;
        if (Math.sign(value) !== Math.sign(above.value)) return bisect(f, above.rate, rate, above.value);
        above = { rate, value };
        if (rate === MWR_HIGH) aboveDone = true;
      }
    }
  }
  return null;
}

/** A root of `f` between `low` and `high`, where `f` changes sign (`fLow` is `f(low)`). */
function bisect(f: (rate: number) => number, low: number, high: number, fLow: number): number {
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
 * The test both returns run first: null when the period held capital (a
 * known value above 0 among `values`, the start, every cut and the end);
 * otherwise `missing_value` when one of them is unknown, else `no_capital`.
 */
function heldCheck(values: readonly Valuation[]): RateOutcome | null {
  if (values.some((valuation) => valuation.valueCents !== null && valuation.valueCents > 0)) return null;
  return unknown(values.some((valuation) => valuation.valueCents === null) ? "missing_value" : "no_capital");
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

/**
 * The TWR's clock in years: the stretches while something is held, each from
 * the start (when it holds something) or the first day ending with a value
 * above 0 to the next day the value is back to 0 (or the period's end),
 * their `yearFraction`s added up. Every value is known here.
 */
function heldYears(start: Valuation, valuations: readonly Valuation[]): number {
  let years = 0;
  let stretchStart: LocalDate | null = null;
  for (const valuation of [start, ...valuations]) {
    const value = valuation.valueCents as Cents;
    if (value > 0 && stretchStart === null) {
      stretchStart = valuation.date;
    } else if (value === 0 && stretchStart !== null) {
      years += yearFraction(stretchStart, valuation.date);
      stretchStart = null;
    }
  }
  const end = valuations.at(-1) ?? start;
  if (stretchStart !== null) years += yearFraction(stretchStart, end.date);
  return years;
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
