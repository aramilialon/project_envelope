/**
 * A portfolio's performance month by month (#89; design.md, "Portfolio
 * module"; domain guide, "Flows, valuation and returns"). Computed on every
 * request from the trades, the stored prices and the stored exchange rates:
 * never stored, never cached.
 *
 * The rules (domain expert, 2026-11-22):
 *
 * - **Value** on a date: the portfolio's positions from its trades dated on or
 *   before it (`positionsAsOfDates`: one replay for every date), each at its latest price on
 *   or before the date (`resolvePrice`: on the same date the workspace's own
 *   price wins over the shared one), quantity × price × price factor rounded
 *   once in the instrument's currency, added up per currency, then converted
 *   once per currency to the base currency at the date's rate (`convertSum`).
 *   A position of quantity 0 needs no price. Any other position with no
 *   price, or a currency with no rate on or before the date, makes the value
 *   unknown (null, never a partial sum) and is listed in `missing`. Prices
 *   and rates have no maximum age: the oldest price date and the oldest rate
 *   date used are returned instead.
 * - **A month's value** is the value at the end of its last calendar day; the
 *   current month's at the end of `today` (the workspace's own date).
 * - **External flows** are `externalFlows` of the portfolio's own trades:
 *   costs and taxes included, so every figure is after costs and taxes. Each
 *   flow is converted to the base currency at its own date's rate: the flows
 *   of one date, kind and currency are added up first, then converted once.
 * - **Net contributions**: the flows other than dividends and coupons.
 *   **Income**: the net cash of dividends and coupons, as a positive amount.
 *   **Gain** = value at the end − value at the start − net contributions +
 *   income, exact in minor units.
 * - **Returns**: the time-weighted return cut at every flow date and at each
 *   month end, and the money-weighted return, each over the month (a row) or
 *   over the whole range in one call (the totals), never by linking rounded
 *   figures. Both get the same cuts and test them for capital held: a month
 *   (or a range) worth nothing at the end of every flow date and month end,
 *   and at its start and end, has no return (`no_capital`), only its gain. A month is always shorter than a year, so a row's returns are
 *   the month's own figures; the totals' are yearly from a year on.
 *
 * Every amount is in the base currency's minor unit; anything that cannot be
 * computed is null, never 0. Pure: no database and no user-facing text
 * (ADR 0004).
 */

import { ValidationError } from "../errors.ts";
import type { AmountInCurrency, FxRate, FxRateTable } from "../market-data/fx.ts";
import { convertAmount, convertSum, fxRateTable } from "../market-data/fx.ts";
import type { Cents, CurrencyCode } from "../money.ts";
import { assertCents, assertKnownCurrency } from "../money.ts";
import type { LocalDate, Month } from "../month.ts";
import { assertDate, assertMonth, monthOf, monthRange, shiftMonth } from "../month.ts";
import type { ExternalFlowKind } from "./external-flows.ts";
import { externalFlows } from "./external-flows.ts";
import type { Positions, PositionTrade } from "./positions.ts";
import { positionsAsOfDates } from "./positions.ts";
import type { PriceCandidate, ResolvedPrice } from "./prices.ts";
import { priceSeriesAt, resolvePrice } from "./prices.ts";
import { amountOf } from "./quantity.ts";
import type { ExternalFlow, ReturnOutcome, UnknownReturnReason, Valuation } from "./returns.ts";
import { moneyWeightedReturn, timeWeightedReturn } from "./returns.ts";

/** The longest range one request covers: ten years of months. */
export const MAX_PERFORMANCE_MONTHS = 120;

/**
 * Why a figure is unknown: `no_price`, an instrument held (or transferred)
 * with no price on or before the date; `no_rate`, no rate on or before the
 * date for `currency` (the instrument's, the flow's, or the base currency).
 */
export type MissingReason = "no_price" | "no_rate";

/**
 * Something a figure needed and did not have. `instrumentId` is null only for
 * a fee or a tax recorded without an instrument whose currency has no rate.
 */
export interface MissingInput {
  readonly instrumentId: string | null;
  readonly reason: MissingReason;
  /** Only for `no_rate`: the currency with no rate on or before the date. */
  readonly currency?: CurrencyCode;
  /** The earliest date, among those the figure needed, that lacks the price or the rate. */
  readonly date: LocalDate;
}

/** The figures of one month, every amount in the base currency's minor unit. */
export interface MonthPerformance {
  readonly month: Month;
  /** The date the month is valued at: its last day, or today for the current month. */
  readonly valuationDate: LocalDate;
  /** The value at the end of `valuationDate`; null when a price or a rate is missing. */
  readonly valueCents: Cents | null;
  /** Flows other than dividends and coupons: + money put in, − money taken out; null when one is unknown. */
  readonly netContributionsCents: Cents | null;
  /** Net dividends and coupons received, as a positive amount; null when one is unknown. */
  readonly incomeCents: Cents | null;
  /** value − the previous month's value − net contributions + income; null when any of them is unknown. */
  readonly gainCents: Cents | null;
  /** The month's time-weighted return in millionths (26694 is 2.6694%); null when unknown. */
  readonly twrE6: number | null;
  /** The month's money-weighted return in millionths; null when unknown. */
  readonly mwrE6: number | null;
  /** Why `twrE6` is null; null when it is known. */
  readonly twrUnknownReason: UnknownReturnReason | null;
  /** Why `mwrE6` is null; null when it is known. */
  readonly mwrUnknownReason: UnknownReturnReason | null;
  /** The oldest price date used for `valueCents`; null when no position needed a price or the value is unknown. */
  readonly oldestPriceDate: LocalDate | null;
  /** The oldest rate date used for `valueCents`; null when no conversion needed a rate or the value is unknown. */
  readonly oldestRateDate: LocalDate | null;
  /** Everything the month's figures needed and did not have, sorted, each once. */
  readonly missing: readonly MissingInput[];
}

/** The figures of the whole range, from the end of the month before `from` to the end of `to`. */
export interface PerformanceTotals {
  /** The end of the month before the range: the value the range starts from. */
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly startValueCents: Cents | null;
  readonly endValueCents: Cents | null;
  readonly netContributionsCents: Cents | null;
  readonly incomeCents: Cents | null;
  readonly gainCents: Cents | null;
  readonly twrE6: number | null;
  /** True when `twrE6` is a yearly rate (a period of a year or more); null when it is unknown. */
  readonly twrAnnualized: boolean | null;
  readonly mwrE6: number | null;
  readonly mwrAnnualized: boolean | null;
  readonly twrUnknownReason: UnknownReturnReason | null;
  readonly mwrUnknownReason: UnknownReturnReason | null;
  readonly missing: readonly MissingInput[];
}

export interface PortfolioPerformance {
  readonly baseCurrency: CurrencyCode;
  readonly from: Month;
  readonly to: Month;
  readonly months: readonly MonthPerformance[];
  readonly totals: PerformanceTotals;
}

export interface MonthlyPerformanceInput {
  readonly portfolioId: string;
  /**
   * The workspace's whole history of every instrument the portfolio has a
   * trade of, other portfolios' and accounts' trades included (a split or a
   * transfer needs them to replay), plus the portfolio's fees and taxes
   * recorded without an instrument. Each trade is in its account's currency,
   * which is its instrument's (the API refuses any other, `currency_mismatch`),
   * so a price values it without a conversion.
   */
  readonly trades: readonly PositionTrade[];
  /** Each instrument's stored prices, own and shared, dated up to the last valuation date at least. */
  readonly priceCandidates: ReadonlyMap<string, readonly PriceCandidate[]>;
  /** The stored rates of every currency involved, dated up to the last valuation date at least. */
  readonly fxRates: readonly FxRate[];
  readonly baseCurrency: CurrencyCode;
  readonly from: Month;
  readonly to: Month;
  /** Today in the workspace's time zone: the current month is valued at its end. */
  readonly today: LocalDate;
}

/**
 * Checks a range of months: two `YYYY-MM` months, `to` not before `from` and
 * not after the month of `today`, at most `MAX_PERFORMANCE_MONTHS` months.
 *
 * @throws ValidationError "invalid_month" (details: field, value, and `max`
 *   for a `to` after the current month) for a malformed month, a `to` before
 *   `from` or after the current month; "range_too_long" (details: months, max)
 *   for a longer range; "invalid_date" for a malformed `today`.
 */
export function assertPerformanceRange(from: unknown, to: unknown, today: LocalDate): void {
  assertDate(today);
  for (const [field, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (typeof value !== "string") {
      throw new ValidationError("invalid_month", `${field} must be one YYYY-MM month`, { field, value: value === undefined ? null : String(value) });
    }
    try {
      assertMonth(value);
    } catch {
      throw new ValidationError("invalid_month", `${field} is not a valid YYYY-MM month`, { field, value });
    }
  }
  const fromMonth = from as Month;
  const toMonth = to as Month;
  if (toMonth < fromMonth) {
    // The same rule as GET /fx-rates and the prices list: the field named is `to`.
    throw new ValidationError("invalid_month", "to is before from", { field: "to", value: toMonth });
  }
  const current = monthOf(today);
  if (toMonth > current) {
    throw new ValidationError("invalid_month", "to is after the current month", { field: "to", value: toMonth, max: current });
  }
  const count = monthRange(fromMonth, toMonth).length;
  if (count > MAX_PERFORMANCE_MONTHS) {
    throw new ValidationError("range_too_long", `a range covers at most ${MAX_PERFORMANCE_MONTHS} months`, {
      months: count,
      max: MAX_PERFORMANCE_MONTHS,
    });
  }
}

/** The last calendar day of a month. */
export function lastDayOfMonth(month: Month): LocalDate {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** What one date's valuation found. */
interface DateValue {
  readonly valueCents: Cents | null;
  readonly oldestPriceDate: LocalDate | null;
  readonly oldestRateDate: LocalDate | null;
  readonly missing: readonly MissingInput[];
}

/** One date's flows, converted: `contribution` and `income` as flows (+ in, − out), null when unknown. */
interface DateFlows {
  readonly contributionCents: Cents | null;
  readonly incomeFlowCents: Cents | null;
  readonly missing: readonly MissingInput[];
}

function olderDate(a: LocalDate | null, b: LocalDate | null): LocalDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Adds two amounts that may be unknown: unknown when either is, never a partial sum. */
function plus(a: Cents | null, b: Cents | null, label: string): Cents | null {
  if (a === null || b === null) return null;
  const total = a + b;
  assertCents(total, label);
  return total;
}

function missingKey(entry: MissingInput): string {
  return JSON.stringify([entry.instrumentId ?? "", entry.reason, entry.currency ?? ""]);
}

/** Each entry once, at its earliest date, sorted by instrument (null first), reason, then currency. */
function distinctMissing(entries: readonly MissingInput[]): MissingInput[] {
  const byKey = new Map<string, MissingInput>();
  for (const entry of entries) {
    const key = missingKey(entry);
    const known = byKey.get(key);
    if (known === undefined || entry.date < known.date) byKey.set(key, entry);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}

function noRate(instrumentId: string | null, currency: CurrencyCode, date: LocalDate): MissingInput {
  return { instrumentId, reason: "no_rate", currency, date };
}

/**
 * The currency a conversion from `from` lacks: `from` itself when it has no
 * rate, otherwise the target's.
 */
function lackingCurrency(currencies: readonly CurrencyCode[], from: CurrencyCode, target: CurrencyCode): CurrencyCode {
  return currencies.includes(from) ? from : target;
}

interface ReturnFigure {
  readonly returnE6: number | null;
  readonly annualized: boolean | null;
  readonly unknownReason: UnknownReturnReason | null;
}

function returnFigure(outcome: ReturnOutcome): ReturnFigure {
  return outcome.status === "known"
    ? { returnE6: outcome.returnE6, annualized: outcome.annualized, unknownReason: null }
    : { returnE6: null, annualized: null, unknownReason: outcome.reason };
}

/**
 * The portfolio's performance for every month from `from` to `to`, and over
 * the whole range (see the module comment).
 *
 * @throws ValidationError the refusals of `assertPerformanceRange`;
 *   "invalid_currency" for a base currency not in use; "invalid_fx_rate",
 *   "duplicate_price" and the replay's errors (`positionsAsOfDates`) for
 *   malformed stored data; "currency_mismatch" (details: tradeId) for a trade
 *   whose currency is not its instrument's.
 */
export function monthlyPerformance(input: MonthlyPerformanceInput): PortfolioPerformance {
  const { portfolioId, trades, priceCandidates, baseCurrency, from, to, today } = input;
  assertPerformanceRange(from, to, today);
  assertKnownCurrency(baseCurrency);
  const rates = fxRateTable(input.fxRates);

  const months = monthRange(from, to);
  const startDate = lastDayOfMonth(shiftMonth(from, -1));
  const monthEnds = months.map((month) => {
    const last = lastDayOfMonth(month);
    return last > today ? today : last;
  });
  const endDate = monthEnds.at(-1) as LocalDate;

  // Every instrument has one currency: the one its trades are in.
  const instrumentCurrency = new Map<string, CurrencyCode>();
  for (const trade of trades) {
    if (trade.instrumentId === null) continue;
    const known = instrumentCurrency.get(trade.instrumentId);
    if (known !== undefined && known !== trade.currency) {
      throw new ValidationError("currency_mismatch", `trade ${trade.id} is not in its instrument's currency`, { tradeId: trade.id });
    }
    instrumentCurrency.set(trade.instrumentId, trade.currency);
  }

  // --- Flows -----------------------------------------------------------------------------
  const own = trades.filter((trade) => trade.portfolioId === portfolioId && trade.date > startDate && trade.date <= endDate);
  const tradeById = new Map(own.map((trade) => [trade.id, trade]));
  const transferPriceMissing: { date: LocalDate; entry: MissingInput }[] = [];
  const flows = externalFlows(own, (instrumentId, date) => {
    const price = resolvePrice(priceCandidates.get(instrumentId) ?? [], date);
    return price === null ? null : price.closeE6;
  });
  // Flows of one date, kind and currency are added up, then converted once.
  const buckets = new Map<LocalDate, Map<string, { kind: ExternalFlowKind; currency: CurrencyCode; cents: Cents | null; trades: PositionTrade[] }>>();
  for (const flow of flows) {
    const trade = tradeById.get(flow.tradeId) as PositionTrade;
    if (flow.amountCents === null) {
      transferPriceMissing.push({ date: flow.date, entry: { instrumentId: trade.instrumentId, reason: "no_price", date: flow.date } });
    }
    let byKey = buckets.get(flow.date);
    if (byKey === undefined) {
      byKey = new Map();
      buckets.set(flow.date, byKey);
    }
    const key = JSON.stringify([flow.kind, flow.currency]);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, { kind: flow.kind, currency: flow.currency, cents: flow.amountCents, trades: [trade] });
    } else {
      bucket.cents = plus(bucket.cents, flow.amountCents, "flow");
      bucket.trades.push(trade);
    }
  }
  const dateFlows = new Map<LocalDate, DateFlows>();
  for (const [date, byKey] of buckets) {
    let contributionCents: Cents | null = 0;
    let incomeFlowCents: Cents | null = 0;
    const missing: MissingInput[] = transferPriceMissing.filter((item) => item.date === date).map((item) => item.entry);
    for (const bucket of byKey.values()) {
      let converted: Cents | null = null;
      if (bucket.cents !== null) {
        const conversion = convertAmount(bucket.cents, bucket.currency, baseCurrency, date, rates);
        if (conversion.status === "known") {
          converted = conversion.cents;
        } else {
          const currency = lackingCurrency(conversion.currencies, bucket.currency, baseCurrency);
          for (const trade of bucket.trades) missing.push(noRate(trade.instrumentId, currency, date));
        }
      }
      if (bucket.kind === "income") incomeFlowCents = plus(incomeFlowCents, converted, "income");
      else contributionCents = plus(contributionCents, converted, "contributions");
    }
    dateFlows.set(date, { contributionCents, incomeFlowCents, missing });
  }
  const flowDates = [...dateFlows.keys()].sort();

  // --- Values ----------------------------------------------------------------------------
  const valuationDates = [...new Set([startDate, ...monthEnds, ...flowDates])].sort();
  const values = valueAt(input, rates, instrumentCurrency, valuationDates);

  const valueOf = (date: LocalDate): DateValue => values.get(date) as DateValue;

  /** The figures from the end of `start` to the end of `end`. */
  const period = (start: LocalDate, end: LocalDate) => {
    const dates = flowDates.filter((date) => date > start && date <= end);
    let netContributionsCents: Cents | null = 0;
    let incomeFlowCents: Cents | null = 0;
    const missing: MissingInput[] = [...valueOf(start).missing, ...valueOf(end).missing];
    const periodFlows: ExternalFlow[] = [];
    for (const date of dates) {
      const day = dateFlows.get(date) as DateFlows;
      netContributionsCents = plus(netContributionsCents, day.contributionCents, "contributions");
      incomeFlowCents = plus(incomeFlowCents, day.incomeFlowCents, "income");
      periodFlows.push({ date, amountCents: plus(day.contributionCents, day.incomeFlowCents, "flow") });
      missing.push(...day.missing, ...valueOf(date).missing);
    }
    const startValue: Valuation = { date: start, valueCents: valueOf(start).valueCents };
    const endValue: Valuation = { date: end, valueCents: valueOf(end).valueCents };
    // Cut at every flow date and every month end: the TWR links them, and both returns test them for capital held.
    const monthEndCuts = monthEnds.filter((date) => date > start && date < end);
    for (const date of monthEndCuts) missing.push(...valueOf(date).missing);
    const cuts = [...new Set([...dates, ...monthEndCuts, end])].sort().map((date) => ({ date, valueCents: valueOf(date).valueCents }));
    // 0 − x, never −x: no income stays 0, not -0.
    const incomeCents = incomeFlowCents === null ? null : 0 - incomeFlowCents;
    let gainCents: Cents | null = null;
    if (endValue.valueCents !== null && startValue.valueCents !== null && netContributionsCents !== null && incomeCents !== null) {
      gainCents = endValue.valueCents - startValue.valueCents - netContributionsCents + incomeCents;
      assertCents(gainCents, "gain");
    }
    const twr = returnFigure(timeWeightedReturn({ start: startValue, valuations: cuts, flows: periodFlows }));
    const mwr = returnFigure(moneyWeightedReturn({ start: startValue, end: endValue, valuations: cuts, flows: periodFlows }));
    return { netContributionsCents, incomeCents, gainCents, twr, mwr, missing: distinctMissing(missing) };
  };

  const rows: MonthPerformance[] = months.map((month, index) => {
    const start = index === 0 ? startDate : (monthEnds[index - 1] as LocalDate);
    const end = monthEnds[index] as LocalDate;
    const figures = period(start, end);
    const value = valueOf(end);
    return {
      month,
      valuationDate: end,
      valueCents: value.valueCents,
      netContributionsCents: figures.netContributionsCents,
      incomeCents: figures.incomeCents,
      gainCents: figures.gainCents,
      twrE6: figures.twr.returnE6,
      mwrE6: figures.mwr.returnE6,
      twrUnknownReason: figures.twr.unknownReason,
      mwrUnknownReason: figures.mwr.unknownReason,
      oldestPriceDate: value.oldestPriceDate,
      oldestRateDate: value.oldestRateDate,
      missing: figures.missing,
    };
  });

  const whole = period(startDate, endDate);
  return {
    baseCurrency,
    from,
    to,
    months: rows,
    totals: {
      startDate,
      endDate,
      startValueCents: valueOf(startDate).valueCents,
      endValueCents: valueOf(endDate).valueCents,
      netContributionsCents: whole.netContributionsCents,
      incomeCents: whole.incomeCents,
      gainCents: whole.gainCents,
      twrE6: whole.twr.returnE6,
      twrAnnualized: whole.twr.annualized,
      mwrE6: whole.mwr.returnE6,
      mwrAnnualized: whole.mwr.annualized,
      twrUnknownReason: whole.twr.unknownReason,
      mwrUnknownReason: whole.mwr.unknownReason,
      missing: whole.missing,
    },
  };
}

/** The portfolio's value at the end of each date (see the module comment). */
function valueAt(
  input: MonthlyPerformanceInput,
  rates: FxRateTable,
  instrumentCurrency: ReadonlyMap<string, CurrencyCode>,
  dates: readonly LocalDate[],
): Map<LocalDate, DateValue> {
  const { portfolioId, trades, priceCandidates, baseCurrency } = input;
  // Each instrument's price on every date, its candidates sorted once.
  const series = new Map<string, (ResolvedPrice | null)[]>();
  for (const instrumentId of instrumentCurrency.keys()) {
    series.set(instrumentId, priceSeriesAt(priceCandidates.get(instrumentId) ?? [], dates));
  }
  const positions = positionsAsOfDates(trades, dates);
  const result = new Map<LocalDate, DateValue>();
  dates.forEach((date, index) => {
    const held = (positions.get(date) as Positions).portfolios.filter(
      (position) => position.portfolioId === portfolioId && position.quantity !== 0,
    );
    const missing: MissingInput[] = [];
    const amounts: (AmountInCurrency & { instrumentId: string })[] = [];
    let oldestPriceDate: LocalDate | null = null;
    for (const position of held) {
      const price = series.get(position.instrumentId)?.[index] ?? null;
      if (price === null) {
        missing.push({ instrumentId: position.instrumentId, reason: "no_price", date });
        continue;
      }
      oldestPriceDate = olderDate(oldestPriceDate, price.priceDate);
      amounts.push({
        instrumentId: position.instrumentId,
        currency: position.currency,
        cents: amountOf(position.quantity, price.closeE6, position.priceFactor, position.currency),
      });
    }
    const conversion = convertSum(amounts, baseCurrency, date, rates);
    if (conversion.status === "unknown") {
      for (const amount of amounts) {
        if (amount.currency === baseCurrency) continue;
        missing.push(noRate(amount.instrumentId, lackingCurrency(conversion.currencies, amount.currency, baseCurrency), date));
      }
    }
    const known = missing.length === 0 && conversion.status === "known";
    result.set(date, {
      valueCents: known ? conversion.cents : null,
      oldestPriceDate: known ? oldestPriceDate : null,
      oldestRateDate: known && conversion.status === "known" ? conversion.rateDate : null,
      missing,
    });
  });
  return result;
}
