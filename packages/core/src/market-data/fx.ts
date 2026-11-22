/**
 * Converting amounts between currencies (#86, ADR 0019).
 *
 * Rates are stored as the ECB publishes them: `rateE10`, the units of the
 * quote currency for one euro, × 10^10 (USD 1.0812 is 10812000000). A rate is
 * never inverted and never stored for another pair: every other pair is
 * computed through the euro, here, and never rounded or kept.
 *
 * The rules (domain expert, 2026-11-22):
 *
 * - the rate on a date is the most recent one on or before it, however old;
 *   the date of the rate used is returned with every converted amount;
 * - with no rate on or before the date, the amount is unknown, never zero;
 * - an amount in the target currency is returned as it is, without a rate,
 *   and the euro converts at exactly 1;
 * - between two currencies that are not the euro, each leg takes its own most
 *   recent rate, and the conversion's rate date is the older of the two;
 * - the result is computed in BigInt and rounded once, half away from zero, to
 *   the target currency's minor unit (ISO 4217 decimals):
 *   to = from × 10^decimals(to) × rate(to) ÷ (rate(from) × 10^decimals(from));
 * - a value (quantity × price × price factor) is converted with one rounding
 *   over the whole product, and a sum is added up in each source currency
 *   first, then converted once per currency.
 *
 * Pure: the caller loads the rates and passes them in.
 */

import { ValidationError } from "../errors.ts";
import type { Cents, CurrencyCode } from "../money.ts";
import { assertCents, currencyDecimals } from "../money.ts";
import type { LocalDate } from "../month.ts";
import { assertDate } from "../month.ts";
import type { Price, PriceFactor, Quantity } from "../portfolio/quantity.ts";
import {
  assertPrice,
  assertPriceFactor,
  assertQuantity,
  divideHalfAwayFromZero,
  PRICE_DECIMALS,
  PRICE_FACTOR_DECIMALS,
  QUANTITY_DECIMALS,
  safeNumber,
} from "../portfolio/quantity.ts";

/** The currency every stored rate is quoted against. */
export const FX_BASE_CURRENCY = "EUR";

/** The scale of a stored rate: `rateE10` is the rate × 10^10. */
export const FX_RATE_DECIMALS = 10;

const RATE_ONE = 10n ** BigInt(FX_RATE_DECIMALS);

/** One stored rate: `rateE10` units of `quote` × 10^10 for one euro, published for `date`. */
export interface FxRate {
  readonly base: typeof FX_BASE_CURRENCY;
  readonly quote: CurrencyCode;
  readonly date: LocalDate;
  readonly rateE10: number;
}

/** Rates indexed for lookup by currency and date; build it with `fxRateTable`. */
export interface FxRateTable {
  readonly byQuote: ReadonlyMap<CurrencyCode, { readonly dates: readonly LocalDate[]; readonly ratesE10: readonly number[] }>;
}

/** The rate of one currency on a date: its value and the date it was published for (null for the euro, which needs none). */
export interface RateOnDate {
  readonly rateE10: number;
  readonly rateDate: LocalDate | null;
}

/**
 * The result of a conversion: the amount in the target currency's minor unit
 * and the date of the oldest rate it used (null when it used none: the same
 * currency, or only the euro); or unknown, with every currency that has no
 * rate on or before the date.
 */
export type Conversion =
  | { readonly status: "known"; readonly cents: Cents; readonly rateDate: LocalDate | null }
  | { readonly status: "unknown"; readonly reason: "no_rate"; readonly currencies: readonly CurrencyCode[] };

/** An amount in its own currency, for `convertSum`. */
export interface AmountInCurrency {
  readonly cents: Cents;
  readonly currency: CurrencyCode;
}

function invalidRate(message: string, details: Record<string, string | number>): ValidationError {
  return new ValidationError("invalid_fx_rate", message, details);
}

/**
 * Checks and indexes stored rates. Each must be quoted against the euro, for
 * another three-letter currency, on a valid date, with a positive safe integer
 * `rateE10`; two rates for the same currency and date are refused.
 *
 * @throws ValidationError "invalid_fx_rate" (details: quote, date, and
 *   `rateE10` or `base` when those are wrong).
 */
export function fxRateTable(rates: readonly FxRate[]): FxRateTable {
  const grouped = new Map<CurrencyCode, FxRate[]>();
  for (const rate of rates) {
    const details = { quote: String(rate.quote), date: String(rate.date) };
    if (rate.base !== FX_BASE_CURRENCY) {
      throw invalidRate(`a rate must be quoted against ${FX_BASE_CURRENCY}: ${String(rate.base)}`, { ...details, base: String(rate.base) });
    }
    if (typeof rate.quote !== "string" || !/^[A-Z]{3}$/.test(rate.quote) || rate.quote === FX_BASE_CURRENCY) {
      throw invalidRate(`not a currency a rate can be quoted in: ${String(rate.quote)}`, details);
    }
    try {
      assertDate(rate.date);
    } catch {
      throw invalidRate(`not a valid rate date: ${String(rate.date)}`, details);
    }
    if (!Number.isSafeInteger(rate.rateE10) || rate.rateE10 <= 0) {
      throw invalidRate(`a rate must be a positive safe integer × 10^10: ${String(rate.rateE10)}`, {
        ...details,
        rateE10: String(rate.rateE10),
      });
    }
    let list = grouped.get(rate.quote);
    if (list === undefined) {
      list = [];
      grouped.set(rate.quote, list);
    }
    list.push(rate);
  }
  const byQuote = new Map<CurrencyCode, { dates: LocalDate[]; ratesE10: number[] }>();
  for (const [quote, list] of grouped) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 1; i < list.length; i++) {
      if (list[i]?.date === list[i - 1]?.date) {
        throw invalidRate(`two rates for ${quote} on ${String(list[i]?.date)}`, { quote, date: String(list[i]?.date) });
      }
    }
    byQuote.set(quote, { dates: list.map((r) => r.date), ratesE10: list.map((r) => r.rateE10) });
  }
  return { byQuote };
}

/**
 * The rate of `currency` on `date`: the most recent one on or before it, with
 * no maximum age; for the euro, exactly 1 with no date. Null when there is no
 * rate on or before the date.
 *
 * @throws ValidationError "invalid_date" for a date that is not YYYY-MM-DD.
 */
export function rateOn(rates: FxRateTable, currency: CurrencyCode, date: LocalDate): RateOnDate | null {
  assertDate(date);
  if (currency === FX_BASE_CURRENCY) return { rateE10: Number(RATE_ONE), rateDate: null };
  const series = rates.byQuote.get(currency);
  if (series === undefined) return null;
  // The last index whose date is on or before `date` (binary search).
  let low = 0;
  let high = series.dates.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((series.dates[middle] ?? "") <= date) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found < 0) return null;
  return { rateE10: series.ratesE10[found] ?? 0, rateDate: series.dates[found] ?? null };
}

/** The older of two rate dates, null meaning "no rate used". */
function olderRateDate(a: LocalDate | null, b: LocalDate | null): LocalDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * The two legs of a conversion from `from` to `to` on `date`, or the
 * currencies that have no rate. Not called for an identity.
 */
function legs(
  rates: FxRateTable,
  from: CurrencyCode,
  to: CurrencyCode,
  date: LocalDate,
): { from: RateOnDate; to: RateOnDate } | { missing: CurrencyCode[] } {
  const fromRate = rateOn(rates, from, date);
  const toRate = rateOn(rates, to, date);
  if (fromRate === null || toRate === null) {
    const missing: CurrencyCode[] = [];
    if (fromRate === null) missing.push(from);
    if (toRate === null) missing.push(to);
    return { missing };
  }
  return { from: fromRate, to: toRate };
}

function toCents(value: bigint, label: string): Cents {
  const cents = safeNumber(value);
  if (cents === null) {
    throw new ValidationError("invalid_amount", `${label} is beyond the safe range of minor units: ${value}`, {
      label,
      value: value.toString(),
    });
  }
  return cents;
}

/**
 * `numerator` (an amount in `from`'s minor unit × `extraScale`) converted to
 * `to`'s minor unit with one rounding, half away from zero:
 * numerator × 10^decimals(to) × rate(to) ÷ (rate(from) × 10^decimals(from) × extraScale).
 */
function convertScaled(numerator: bigint, extraScale: bigint, from: CurrencyCode, to: CurrencyCode, leg: { from: RateOnDate; to: RateOnDate }): bigint {
  const toScale = 10n ** BigInt(currencyDecimals(to));
  const fromScale = 10n ** BigInt(currencyDecimals(from));
  return divideHalfAwayFromZero(numerator * toScale * BigInt(leg.to.rateE10), BigInt(leg.from.rateE10) * fromScale * extraScale);
}

/**
 * `cents`, in `from`'s minor unit, converted to `to` on `date`.
 *
 * @example convertAmount(108000, "USD", "EUR", "2026-11-20", rates) // known, 99889 (€998.89) at USD 1.0812
 * @throws ValidationError "invalid_amount" for an amount, or a result, beyond
 *   the safe range of minor units; "invalid_date" for a date that is not YYYY-MM-DD.
 */
export function convertAmount(cents: Cents, from: CurrencyCode, to: CurrencyCode, date: LocalDate, rates: FxRateTable): Conversion {
  assertCents(cents);
  assertDate(date);
  if (from === to) return { status: "known", cents, rateDate: null };
  const leg = legs(rates, from, to, date);
  if ("missing" in leg) return { status: "unknown", reason: "no_rate", currencies: leg.missing };
  const converted = convertScaled(BigInt(cents), 1n, from, to, leg);
  return { status: "known", cents: toCents(converted, "converted amount"), rateDate: olderRateDate(leg.from.rateDate, leg.to.rateDate) };
}

const PRODUCT_SCALE = 10n ** BigInt(QUANTITY_DECIMALS + PRICE_DECIMALS + PRICE_FACTOR_DECIMALS);

/**
 * The value of `quantity` units at `price` × `priceFactor`, quoted in
 * `instrumentCurrency`, in `target`'s minor unit on `date`, rounded once over
 * the whole product: never the amount in the instrument's currency rounded
 * first. In the instrument's own currency it equals `amountOf`.
 *
 * @throws ValidationError "invalid_quantity", "invalid_price",
 *   "invalid_price_factor" for invalid inputs; "invalid_amount" for a result
 *   beyond the safe range; "invalid_date" for a date that is not YYYY-MM-DD.
 */
export function valueIn(
  quantity: Quantity,
  price: Price,
  priceFactor: PriceFactor,
  instrumentCurrency: CurrencyCode,
  target: CurrencyCode,
  date: LocalDate,
  rates: FxRateTable,
): Conversion {
  assertQuantity(quantity);
  assertPrice(price);
  assertPriceFactor(priceFactor);
  assertDate(date);
  const product = BigInt(quantity) * BigInt(price) * BigInt(priceFactor);
  if (instrumentCurrency === target) {
    const scale = 10n ** BigInt(currencyDecimals(target));
    return { status: "known", cents: toCents(divideHalfAwayFromZero(product * scale, PRODUCT_SCALE), "value"), rateDate: null };
  }
  const leg = legs(rates, instrumentCurrency, target, date);
  if ("missing" in leg) return { status: "unknown", reason: "no_rate", currencies: leg.missing };
  // The product in the instrument's minor unit is product × 10^decimals(instrument) ÷ PRODUCT_SCALE;
  // passing it unrounded, with PRODUCT_SCALE as the extra divisor, keeps a single rounding.
  const fromScale = 10n ** BigInt(currencyDecimals(instrumentCurrency));
  const converted = convertScaled(product * fromScale, PRODUCT_SCALE, instrumentCurrency, target, leg);
  return { status: "known", cents: toCents(converted, "value"), rateDate: olderRateDate(leg.from.rateDate, leg.to.rateDate) };
}

/**
 * The sum of amounts in several currencies, in `target`'s minor unit on
 * `date`: the amounts are added up in each currency first, and each
 * currency's total is converted once, so the result does not depend on how
 * the amounts are split. Unknown, never a partial sum, when any currency has
 * no rate; `currencies` lists every such currency, in alphabetical order.
 * `rateDate` is the oldest rate date used.
 *
 * @throws ValidationError "invalid_amount" for an amount that is not a safe
 *   integer; "amount_total_overflow" (details: label) for a result beyond the
 *   safe range; "invalid_date" for a date that is not YYYY-MM-DD.
 */
export function convertSum(amounts: readonly AmountInCurrency[], target: CurrencyCode, date: LocalDate, rates: FxRateTable): Conversion {
  assertDate(date);
  const totals = new Map<CurrencyCode, bigint>();
  for (const amount of amounts) {
    assertCents(amount.cents);
    totals.set(amount.currency, (totals.get(amount.currency) ?? 0n) + BigInt(amount.cents));
  }
  let total = 0n;
  let rateDate: LocalDate | null = null;
  const missing = new Set<CurrencyCode>();
  for (const [currency, sum] of totals) {
    if (currency === target) {
      total += sum;
      continue;
    }
    const leg = legs(rates, currency, target, date);
    if ("missing" in leg) {
      for (const code of leg.missing) missing.add(code);
      continue;
    }
    total += convertScaled(sum, 1n, currency, target, leg);
    rateDate = olderRateDate(rateDate, olderRateDate(leg.from.rateDate, leg.to.rateDate));
  }
  if (missing.size > 0) return { status: "unknown", reason: "no_rate", currencies: [...missing].sort() };
  const cents = safeNumber(total);
  if (cents === null) {
    throw new ValidationError("amount_total_overflow", `converted total is beyond the safe range of minor units: ${total}`, {
      label: "converted total",
    });
  }
  return { status: "known", cents, rateDate };
}
