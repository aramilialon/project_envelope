/**
 * Quantities and prices of financial instruments (ADR 0011).
 *
 * Like amounts (ADR 0002), they are integers, never fractional numbers, but
 * scaled by a fixed power of ten instead of the currency's minor unit:
 *
 * - a `Quantity` is a number of units × 10^8: 1.5 shares is 150000000;
 * - a `Price` is the price as quoted for one unit × 10^6: €87.123456 is
 *   87123456. It is in the instrument's currency when the price factor is 1;
 *   otherwise the amount per unit is price × price factor (a bond quoted in
 *   percent of nominal, a share quoted in pence);
 * - a `PriceFactor` is × 10^6 as well: 1 (1000000) for most instruments, 0.01
 *   (10000) for bonds quoted in percent of nominal and for instruments quoted
 *   in hundredths of their currency.
 *
 * The amount of a trade is quantity × price × price factor. Such products
 * easily go beyond 2^53, where JavaScript numbers stop being exact, so every
 * product and quotient here is computed with BigInt and converted back to a
 * checked safe integer. Nothing outside this module multiplies or divides
 * scaled values, except `market-data/fx.ts`, which converts the same products
 * into another currency with this module's rounding helper.
 *
 * Each conversion rounds by exactly one rule (ADR 0011, "Rounding"):
 * - quantity × price → amount: half away from zero, once, at the end;
 * - amount → quantity: toward zero, so an order never spends more than the
 *   money available;
 * - amount ÷ quantity → price: half to even, for display only;
 * - cost × sold ÷ held: half away from zero, and selling everything removes
 *   exactly the cost that is left.
 */

import { ValidationError } from "../errors.ts";
import type { Cents, CurrencyCode, Locale } from "../money.ts";
import { assertCents, currencyDecimals, localeSeparators, matchLocaleDecimal } from "../money.ts";

/** A number of units of an instrument × 10^8. Positive or negative, like an amount. */
export type Quantity = number & { readonly __brand: "Quantity" };

/**
 * The price as quoted for one unit × 10^6. In the instrument's currency when
 * the price factor is 1; otherwise the amount per unit is price × price factor.
 * Never negative.
 */
export type Price = number & { readonly __brand: "Price" };

/** The factor between quantity × price and the amount, × 10^6. Always positive. */
export type PriceFactor = number & { readonly __brand: "PriceFactor" };

/** Decimals of a quantity: the `e8` in `quantity_e8`. */
export const QUANTITY_DECIMALS = 8;
/** Decimals of a price: the `e6` in `price_e6`. */
export const PRICE_DECIMALS = 6;
/** Decimals of a price factor: the `e6` in `price_factor_e6`. */
export const PRICE_FACTOR_DECIMALS = 6;

/** One whole unit, for example the step of an order when fractional units are off. */
export const ONE_UNIT = 100_000_000 as Quantity;
/** Price factor 1: the amount is quantity × price. */
export const PRICE_FACTOR_ONE = 1_000_000 as PriceFactor;
/** Price factor 0.01: bonds quoted in percent of nominal, instruments quoted in hundredths of their currency. */
export const PRICE_FACTOR_HUNDREDTH = 10_000 as PriceFactor;

const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_DECIMALS);
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
const PRICE_FACTOR_SCALE = 10n ** BigInt(PRICE_FACTOR_DECIMALS);

// --- Validation -------------------------------------------------------------

/**
 * Checks that a value is a valid quantity: a safe integer of units × 10^8
 * (up to about 90 million units either way).
 *
 * @throws ValidationError with code "invalid_quantity".
 */
export function assertQuantity(value: number, label = "quantity"): asserts value is Quantity {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError("invalid_quantity", `${label} is not a safe integer of units × 10^8: ${value}`, {
      label,
      value: String(value),
    });
  }
}

/**
 * Checks that a value is a valid price: a safe, non-negative integer of the
 * price × 10^6 (up to about 9 billion per unit).
 *
 * @throws ValidationError with code "invalid_price".
 */
export function assertPrice(value: number, label = "price"): asserts value is Price {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError("invalid_price", `${label} is not a non-negative safe integer of price × 10^6: ${value}`, {
      label,
      value: String(value),
    });
  }
}

/**
 * Checks that a value is a valid price factor: a positive safe integer of the
 * factor × 10^6.
 *
 * @throws ValidationError with code "invalid_price_factor".
 */
export function assertPriceFactor(value: number, label = "priceFactor"): asserts value is PriceFactor {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError("invalid_price_factor", `${label} is not a positive safe integer of factor × 10^6: ${value}`, {
      label,
      value: String(value),
    });
  }
}

/** Validates a scaled integer read from the database, the API or sync, and returns it as a `Quantity`. */
export function toQuantity(value: number, label = "quantity"): Quantity {
  assertQuantity(value, label);
  return value;
}

/** Validates a scaled integer read from the database, the API or sync, and returns it as a `Price`. */
export function toPrice(value: number, label = "price"): Price {
  assertPrice(value, label);
  return value;
}

/** Validates a scaled integer read from the database, the API or sync, and returns it as a `PriceFactor`. */
export function toPriceFactor(value: number, label = "priceFactor"): PriceFactor {
  assertPriceFactor(value, label);
  return value;
}

// --- Parsing ----------------------------------------------------------------

/**
 * Reads a decimal number typed in a locale as an exact scaled BigInt, or
 * returns null if the text does not match the locale's conventions or has
 * more than `decimals` decimals.
 */
function parseScaled(text: string, locale: Locale, decimals: number): bigint | null {
  const parts = matchLocaleDecimal(text, locale, decimals);
  if (parts === null) return null;
  const magnitude = BigInt(parts.integerDigits + parts.fractionDigits.padEnd(decimals, "0"));
  return parts.negative ? -magnitude : magnitude;
}

/**
 * Parses a quantity typed by the user, following the locale's separators, with
 * at most 8 decimals.
 *
 * @example parseQuantity("1,14779652", { locale: "it-IT" }) // 114779652
 * @example parseQuantity("1,000.5", { locale: "en-US" }) // 100050000000
 * @throws ValidationError with code "invalid_quantity_format", or "invalid_quantity" beyond the safe range.
 */
export function parseQuantity(text: string, options: { locale: Locale }): Quantity {
  const scaled = parseScaled(text, options.locale, QUANTITY_DECIMALS);
  if (scaled === null) {
    throw new ValidationError("invalid_quantity_format", `not a valid quantity for ${options.locale}: "${text}"`, {
      text,
      locale: options.locale,
    });
  }
  return quantityFromBigint(scaled);
}

/**
 * Parses a price typed by the user, following the locale's separators, with
 * at most 6 decimals.
 *
 * @example parsePrice("87,123456", { locale: "it-IT" }) // 87123456
 * @throws ValidationError with code "invalid_price_format", or "invalid_price" if negative or beyond the safe range.
 */
export function parsePrice(text: string, options: { locale: Locale }): Price {
  const scaled = parseScaled(text, options.locale, PRICE_DECIMALS);
  if (scaled === null) {
    throw new ValidationError("invalid_price_format", `not a valid price for ${options.locale}: "${text}"`, {
      text,
      locale: options.locale,
    });
  }
  return priceFromBigint(scaled);
}

// --- Formatting -------------------------------------------------------------

const integerFormatterCache = new Map<string, Intl.NumberFormat>();
const decimalSeparatorCache = new Map<string, string>();

function numberOptions(currency: CurrencyCode | undefined): Intl.NumberFormatOptions {
  return currency === undefined ? {} : { style: "currency", currency };
}

/** A formatter for the integer part only: the fraction is appended exactly, digit by digit. */
function integerFormatter(locale: Locale, currency: CurrencyCode | undefined): Intl.NumberFormat {
  const key = `${locale}|${currency ?? ""}`;
  let formatter = integerFormatterCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      ...numberOptions(currency),
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    integerFormatterCache.set(key, formatter);
  }
  return formatter;
}

/** The decimal separator the locale uses for plain numbers or for amounts in a currency. */
function decimalSeparator(locale: Locale, currency: CurrencyCode | undefined): string {
  if (currency === undefined) return localeSeparators(locale).decimal;
  const key = `${locale}|${currency}`;
  let separator = decimalSeparatorCache.get(key);
  if (separator === undefined) {
    const parts = new Intl.NumberFormat(locale, {
      ...numberOptions(currency),
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).formatToParts(1.5);
    separator = parts.find((p) => p.type === "decimal")?.value ?? localeSeparators(locale).decimal;
    decimalSeparatorCache.set(key, separator);
  }
  return separator;
}

/**
 * Formats a scaled integer exactly, without going through a floating-point
 * number: Intl lays out the sign, the grouped integer part and the currency
 * symbol, and the fraction digits are inserted as they are, with trailing
 * zeros dropped down to `minimumFractionDigits`.
 */
function formatScaled(
  value: number,
  decimals: number,
  minimumFractionDigits: number,
  locale: Locale,
  currency: CurrencyCode | undefined,
): string {
  const scaled = BigInt(value);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const scale = 10n ** BigInt(decimals);
  const integer = magnitude / scale;
  let fraction = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction.length < minimumFractionDigits) fraction = fraction.padEnd(minimumFractionDigits, "0");

  const formatter = integerFormatter(locale, currency);
  // Formatting ±1 gives the layout (sign, symbol, spacing) even when the integer part is 0.
  const layout = formatter.formatToParts(negative ? -1n : 1n);
  const digits = formatter
    .formatToParts(integer)
    .filter((p) => p.type === "integer" || p.type === "group")
    .map((p) => p.value)
    .join("");
  const fractionText = fraction === "" ? "" : decimalSeparator(locale, currency) + fraction;
  return layout.map((p) => (p.type === "integer" ? digits + fractionText : p.value)).join("");
}

/**
 * Formats a quantity for display in the user's locale, with as many decimals
 * as it has (at most 8).
 *
 * @example formatQuantity(114779652, { locale: "it-IT" }) // "1,14779652"
 * @example formatQuantity(100050000000, { locale: "en-US" }) // "1,000.5"
 */
export function formatQuantity(quantity: Quantity, options: { locale: Locale }): string {
  assertQuantity(quantity);
  return formatScaled(quantity, QUANTITY_DECIMALS, 0, options.locale, undefined);
}

/**
 * Formats a price for display in the user's locale, with as many decimals as
 * it has (at most 6). With a currency it is shown as an amount in that
 * currency, with at least the currency's own decimals; without one as a plain
 * number. Pass the currency only when the instrument's price factor is 1: any
 * other price (a bond in percent of nominal, a share in pence) is not an
 * amount in the instrument's currency and is shown without it.
 *
 * @example formatPrice(87123456, { locale: "en-US", currency: "EUR" }) // "€87.123456"
 * @example formatPrice(87500000, { locale: "en-US", currency: "EUR" }) // "€87.50"
 * @example formatPrice(98765432, { locale: "it-IT" }) // "98,765432"
 */
export function formatPrice(price: Price, options: { locale: Locale; currency?: CurrencyCode }): string {
  assertPrice(price);
  const { locale, currency } = options;
  const minimum = currency === undefined ? 0 : Math.min(currencyDecimals(currency), PRICE_DECIMALS);
  return formatScaled(price, PRICE_DECIMALS, minimum, locale, currency);
}

// --- Arithmetic -------------------------------------------------------------

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * n ÷ d rounded half away from zero; d must be positive. Internal to the core
 * (also used by `market-data/fx.ts`): not exported from the package.
 */
export function divideHalfAwayFromZero(n: bigint, d: bigint): bigint {
  const quotient = n / d; // BigInt division truncates toward zero
  const remainder = n % d;
  if (2n * abs(remainder) >= d) return quotient + (n < 0n ? -1n : 1n);
  return quotient;
}

/** n ÷ d rounded half to even; d must be positive. */
function divideHalfEven(n: bigint, d: bigint): bigint {
  const quotient = n / d;
  const twiceRemainder = 2n * abs(n % d);
  if (twiceRemainder > d || (twiceRemainder === d && quotient % 2n !== 0n)) {
    return quotient + (n < 0n ? -1n : 1n);
  }
  return quotient;
}

/** A BigInt result as a number, or null if it is beyond the safe range. Internal to the core. */
export function safeNumber(value: bigint): number | null {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) && BigInt(asNumber) === value ? asNumber : null;
}

function quantityFromBigint(value: bigint, label = "quantity"): Quantity {
  const quantity = safeNumber(value);
  if (quantity === null) {
    throw new ValidationError("invalid_quantity", `${label} is beyond the safe range of units × 10^8: ${value}`, {
      label,
      value: value.toString(),
    });
  }
  return toQuantity(quantity, label);
}

function priceFromBigint(value: bigint, label = "price"): Price {
  const price = safeNumber(value);
  if (price === null) {
    throw new ValidationError("invalid_price", `${label} is beyond the safe range of price × 10^6: ${value}`, {
      label,
      value: value.toString(),
    });
  }
  return toPrice(price, label);
}

function centsFromBigint(value: bigint, label: string): Cents {
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
 * The amount of `quantity` units at `price`, in the currency's minor unit:
 * quantity × price × price factor, rounded once, half away from zero.
 * The amount stored on a trade may differ from it, to match the broker.
 *
 * @example amountOf(1_000_000_000_000, 98_765_432, PRICE_FACTOR_HUNDREDTH, "EUR") // 987654 (10,000 nominal at 98.765432%)
 * @throws ValidationError "invalid_amount" if the result is beyond the safe range.
 */
export function amountOf(quantity: Quantity, price: Price, priceFactor: PriceFactor, currency: CurrencyCode): Cents {
  assertQuantity(quantity);
  assertPrice(price);
  assertPriceFactor(priceFactor);
  const minorScale = 10n ** BigInt(currencyDecimals(currency));
  const numerator = BigInt(quantity) * BigInt(price) * BigInt(priceFactor) * minorScale;
  return centsFromBigint(divideHalfAwayFromZero(numerator, QUANTITY_SCALE * PRICE_SCALE * PRICE_FACTOR_SCALE), "amount");
}

/**
 * How many units `amount` buys at `price`: rounded toward zero to 8 decimals,
 * then down to a multiple of `step` (for example `ONE_UNIT` when fractional
 * units are off), so `amountOf` the result never exceeds `amount`. The amount
 * passed must already be net of fees; a broker that rounds its own charge up
 * can still charge one minor unit more.
 *
 * @example quantityFor(10000, 87_123_456, PRICE_FACTOR_ONE, "EUR") // 114779652 (€100 at €87.123456)
 * @throws ValidationError "invalid_price" if the price is zero, "invalid_quantity_step" if the step is not positive.
 */
export function quantityFor(
  amount: Cents,
  price: Price,
  priceFactor: PriceFactor,
  currency: CurrencyCode,
  step?: Quantity,
): Quantity {
  assertCents(amount);
  assertPrice(price);
  assertPriceFactor(priceFactor);
  if (price === 0) {
    throw new ValidationError("invalid_price", "cannot compute a quantity at a price of zero", {
      label: "price",
      value: "0",
    });
  }
  if (step !== undefined && (!Number.isSafeInteger(step) || step <= 0)) {
    throw new ValidationError("invalid_quantity_step", `step is not a positive safe integer of units × 10^8: ${step}`, {
      value: String(step),
    });
  }
  const minorScale = 10n ** BigInt(currencyDecimals(currency));
  const numerator = BigInt(amount) * QUANTITY_SCALE * PRICE_SCALE * PRICE_FACTOR_SCALE;
  let quantity = numerator / (minorScale * BigInt(price) * BigInt(priceFactor)); // toward zero
  if (step !== undefined) {
    const bigStep = BigInt(step);
    quantity = (quantity / bigStep) * bigStep; // toward zero
  }
  return quantityFromBigint(quantity);
}

/**
 * The price per unit implied by paying `amount` for `quantity` units, for
 * example a position's average cost: rounded half to even to 6 decimals.
 * For display only: never stored, never used to compute anything else.
 *
 * @example priceFrom(100000, 300_000_000, PRICE_FACTOR_ONE, "EUR") // 333333333 (€1,000 for 3 units)
 * @throws ValidationError "invalid_quantity" if the quantity is zero, "invalid_price" if the result is negative or too large.
 */
export function priceFrom(amount: Cents, quantity: Quantity, priceFactor: PriceFactor, currency: CurrencyCode): Price {
  assertCents(amount);
  assertQuantity(quantity);
  assertPriceFactor(priceFactor);
  if (quantity === 0) {
    throw new ValidationError("invalid_quantity", "cannot compute a price for a quantity of zero", {
      label: "quantity",
      value: "0",
    });
  }
  const minorScale = 10n ** BigInt(currencyDecimals(currency));
  let numerator = BigInt(amount) * QUANTITY_SCALE * PRICE_SCALE * PRICE_FACTOR_SCALE;
  let denominator = minorScale * BigInt(quantity) * BigInt(priceFactor);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  return priceFromBigint(divideHalfEven(numerator, denominator));
}

/**
 * The part of a position's `cost` that leaves it when `sold` of its `held`
 * units are sold: cost × sold ÷ held, rounded half away from zero. Selling
 * every unit returns the whole cost, so whatever was rounded on earlier sales
 * is never left behind. The result depends on how sales are split (a cost of
 * 101 on 4 units: selling 1 then 1 removes 25 + 25, selling 2 at once removes
 * 51), so positions are rebuilt by replaying trades in one fixed order
 * (ADR 0011).
 *
 * @example proportionalCost(100000, 100_000_000, 300_000_000) // 33333 (a third of €1,000)
 * @throws ValidationError "invalid_sale_quantity" unless 0 ≤ sold ≤ held and held > 0.
 */
export function proportionalCost(cost: Cents, sold: Quantity, held: Quantity): Cents {
  assertCents(cost, "cost");
  assertQuantity(sold, "sold");
  assertQuantity(held, "held");
  if (held <= 0 || sold < 0 || sold > held) {
    throw new ValidationError("invalid_sale_quantity", `cannot sell ${sold} of ${held} units × 10^8`, {
      sold: String(sold),
      held: String(held),
    });
  }
  if (sold === held) return cost;
  return centsFromBigint(divideHalfAwayFromZero(BigInt(cost) * BigInt(sold), BigInt(held)), "cost");
}
