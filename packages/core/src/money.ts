/**
 * Money amounts.
 *
 * Project rule: an amount is ALWAYS an integer number of the currency's minor
 * unit (cents for EUR and USD, yen for JPY). €12.34 is stored as 1234.
 * Never use fractional numbers: in JavaScript, as in Perl, 0.1 + 0.2 is not
 * exactly 0.3, and in a finance app a wrong cent is a bug.
 *
 * Reading and displaying amounts depends on the user's locale ("1.234,56" in
 * Italy, "1,234.56" in the US) and on the currency's number of decimals.
 * Both are handled here with the standard Intl API, so the rest of the code
 * only ever sees integers.
 */

import { ValidationError } from "./errors.ts";

/** An amount in the currency's minor unit (cents for EUR). */
export type Cents = number;

/** An ISO 4217 currency code, for example "EUR" or "USD". */
export type CurrencyCode = string;

/** A BCP 47 locale tag, for example "it-IT" or "en-US". */
export type Locale = string;

/**
 * The largest single amount the app accepts, in minor units: 10^12, which is
 * €10,000,000,000.00 for a currency with two decimals (ADR 0002). Every amount
 * a user or a file writes (a transaction, a split, a transfer, an assignment,
 * a trade's figures, a target…) is checked against it with `assertAmount`, so
 * that adding up all of a workspace's amounts stays inside the safe integer
 * range: about 9,000 amounts at the cap before any sum could lose precision.
 * Sums and balances, a statement's balance included, are not capped. It is a
 * number of minor units, whatever the currency: ¥1,000,000,000,000 for one
 * with no decimals, 1,000,000,000.000 for one with three.
 */
export const MAX_AMOUNT_CENTS: Cents = 1_000_000_000_000;

/**
 * Checks that a value is a valid amount: a "safe" integer, meaning it can be
 * represented without losing precision (up to about 90 trillion euros).
 * Sums and balances are checked with this one; a single amount being written
 * is checked with `assertAmount`, which also applies the cap.
 *
 * @throws ValidationError with code "invalid_amount".
 */
export function assertCents(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError("invalid_amount", `${label} is not a safe integer of minor units: ${value}`, {
      label,
      value: String(value),
    });
  }
}

/**
 * Checks a single amount being written: a safe integer (`assertCents`) no
 * larger than `MAX_AMOUNT_CENTS` either way.
 *
 * @throws ValidationError "invalid_amount" for a value that is not a safe
 *   integer; "amount_too_large" (details: label, max, value) for one beyond
 *   the cap.
 */
export function assertAmount(value: number, label = "amount"): void {
  if (Number.isInteger(value) && Math.abs(value) > MAX_AMOUNT_CENTS) {
    throw amountTooLarge(value, label);
  }
  assertCents(value, label);
}

function amountTooLarge(value: number, label: string): ValidationError {
  return new ValidationError("amount_too_large", `${label} is beyond ${MAX_AMOUNT_CENTS} minor units: ${value}`, {
    label,
    max: MAX_AMOUNT_CENTS,
    value: String(value),
  });
}

/**
 * Checks that a total (a sum of amounts) is still a safe integer. Each amount
 * is capped, so only a sum of tens of thousands of them at the cap, or of
 * amounts stored before the cap, can fail this.
 *
 * @throws ValidationError "amount_total_overflow" (details: label, plus the
 *   caller's own `details` naming what was being added up).
 */
export function assertTotal(value: number, label: string, details: Record<string, string | number> = {}): void {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError("amount_total_overflow", `${label} is beyond the safe range of minor units: ${value}`, {
      ...details,
      label,
    });
  }
}

/** Adds up a list of amounts, validating each one; a total beyond the safe range is "amount_total_overflow". */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    assertCents(value);
    total += value;
  }
  assertTotal(total, "total");
  return total;
}

let knownCurrencies: ReadonlySet<string> | undefined;

/**
 * Whether a value is an upper-case ISO 4217 code the runtime knows and still
 * lists as in use (`Intl.supportedValuesOf("currency")`): "EUR" and "JPY" are,
 * "eur", "EURO", "XYZ" and the withdrawn "VEF" are not (#652). The one check
 * for every currency the app stores, so a workspace and its accounts agree.
 */
export function isKnownCurrency(value: unknown): value is CurrencyCode {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) return false;
  knownCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  return knownCurrencies.has(value);
}

/**
 * @throws ValidationError "invalid_currency" (`details`: `currency`) unless
 * `isKnownCurrency(value)`.
 */
export function assertKnownCurrency(value: unknown): asserts value is CurrencyCode {
  if (!isKnownCurrency(value)) {
    throw new ValidationError("invalid_currency", `"${String(value)}" is not a known currency code`, { currency: String(value) });
  }
}

const currencyDecimalsCache = new Map<CurrencyCode, number>();

/**
 * Number of decimals of a currency: 2 for EUR, 0 for JPY, 3 for KWD; 2 for a
 * non-empty code `Intl` cannot read at all (such as "EURO", stored before #652
 * checked an account's currency), so one bad row never stops a whole screen.
 * A missing or empty currency is a bug, not stored data, and still throws.
 */
export function currencyDecimals(currency: CurrencyCode): number {
  const cached = currencyDecimalsCache.get(currency);
  if (cached !== undefined) return cached;
  let decimals = 2;
  try {
    decimals = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch (error) {
    // An ill-formed stored code keeps the default; a missing one is a caller's bug.
    if (typeof currency !== "string" || currency === "") throw error;
  }
  currencyDecimalsCache.set(currency, decimals);
  return decimals;
}

export interface Separators {
  readonly group: string;
  readonly decimal: string;
}

const separatorsCache = new Map<Locale, Separators>();

/** Group and decimal separators of a locale: "." and "," for it-IT, "," and "." for en-US. */
function separatorsFor(locale: Locale): Separators {
  const cached = separatorsCache.get(locale);
  if (cached !== undefined) return cached;
  const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567.8);
  const separators: Separators = {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
  separatorsCache.set(locale, separators);
  return separators;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regular expression for the group separator. Some locales use characters
 * that are hard to type: a (narrow) non-breaking space in French, a
 * typographic apostrophe in Swiss German. For those we also accept the
 * characters people actually type.
 */
function groupPattern(group: string): string {
  if (/^[\s\u00a0\u202f]$/.test(group)) return "[ \\u00a0\\u202f]";
  if (group === "\u2019" || group === "'") return "['\\u2019]";
  return escapeRegExp(group);
}

/**
 * Parses an amount typed by the user, following the locale's separators, and
 * returns it in minor units.
 *
 * Accepted: an optional leading "-", digits with or without group separators
 * (in groups of three), and at most as many decimals as the currency has.
 *
 * @example parseAmount("1.234,56", { locale: "it-IT", currency: "EUR" }) // 123456
 * @example parseAmount("1,234.56", { locale: "en-US", currency: "USD" }) // 123456
 * @throws ValidationError with code "invalid_amount_format", or "amount_too_large"
 *   (details: label, max, value) beyond `MAX_AMOUNT_CENTS`.
 */
export function parseAmount(text: string, options: { locale: Locale; currency: CurrencyCode }): Cents {
  const result = parseMinorUnits(text, options);
  // Too many digits to be exact is too large too: the cap is far inside the safe range.
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_AMOUNT_CENTS) throw amountTooLarge(result, "amount");
  return result;
}

/**
 * Parses a balance typed by the user, such as a statement's closing balance,
 * like `parseAmount` but without the cap on a single amount: a balance is only
 * compared with the account's, never written or added up (ADR 0002, #651).
 *
 * @throws ValidationError with code "invalid_amount_format", or "invalid_amount"
 *   (details: label, value) beyond the safe range of minor units.
 */
export function parseBalance(text: string, options: { locale: Locale; currency: CurrencyCode }): Cents {
  const result = parseMinorUnits(text, options);
  assertCents(result, "amount");
  return result;
}

function parseMinorUnits(text: string, options: { locale: Locale; currency: CurrencyCode }): Cents {
  const decimals = currencyDecimals(options.currency);
  const parts = matchLocaleDecimal(text, options.locale, decimals);
  if (parts === null) {
    throw new ValidationError("invalid_amount_format", `not a valid amount for ${options.locale}: "${text}"`, {
      text,
      locale: options.locale,
    });
  }
  const whole = Number(parts.integerDigits);
  const minor = decimals > 0 ? Number(parts.fractionDigits.padEnd(decimals, "0")) : 0;
  const result = whole * 10 ** decimals + minor;
  // "-0" would become -0: normalize it to 0. The callers check the range.
  return !parts.negative || result === 0 ? result : -result;
}

/** The pieces of a decimal number typed in a locale, digits only. */
export interface LocaleDecimalParts {
  readonly negative: boolean;
  /** The integer part without group separators, for example "1234". */
  readonly integerDigits: string;
  /** The fraction digits as typed, at most `maxDecimals` of them, possibly empty. */
  readonly fractionDigits: string;
}

/**
 * Splits a decimal number typed in a locale into its sign, integer digits and
 * fraction digits, or returns null if it does not match the locale's
 * conventions: an optional leading "-", digits with or without group
 * separators (in groups of three), and at most `maxDecimals` decimals after
 * the locale's decimal separator.
 *
 * Shared by every parser of typed numbers (amounts here, quantities and prices
 * in `portfolio/quantity.ts`), so they all accept the same input. Internal to
 * the core: not exported from the package.
 */
export function matchLocaleDecimal(text: string, locale: Locale, maxDecimals: number): LocaleDecimalParts | null {
  const { group, decimal } = separatorsFor(locale);
  const g = groupPattern(group);
  const d = escapeRegExp(decimal);
  const fraction = maxDecimals > 0 ? `(?:${d}(\\d{1,${maxDecimals}}))?` : "()";
  const pattern = new RegExp(`^(-)?(\\d{1,3}(?:${g}\\d{3})+|\\d+)${fraction}$`);

  const match = pattern.exec(text.trim());
  if (match === null) return null;
  const [, minus, integerPart = "0", fractionPart = ""] = match;
  return {
    negative: minus !== undefined,
    integerDigits: integerPart.replace(new RegExp(g, "g"), ""),
    fractionDigits: fractionPart,
  };
}

/**
 * The group and decimal separators of a locale, for formatters that assemble
 * a number themselves. Internal to the core: not exported from the package.
 */
export function localeSeparators(locale: Locale): Separators {
  return separatorsFor(locale);
}

const formatterCache = new Map<string, Intl.NumberFormat>();

/**
 * Formats an amount for display, in the user's locale.
 *
 * @example formatMoney(123456, { locale: "en-US", currency: "EUR" }) // "€1,234.56"
 * @example formatMoney(123456, { locale: "it-IT", currency: "EUR" }) // "1234,56 €" (non-breaking space)
 *
 * A code `Intl` cannot read (such as "EURO", stored before #652 checked an
 * account's currency) gives the amount followed by that code, never an exception.
 */
export function formatMoney(cents: Cents, options: { locale: Locale; currency: CurrencyCode }): string {
  assertCents(cents);
  const cacheKey = `${options.locale}|${options.currency}`;
  let formatter = formatterCache.get(cacheKey);
  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat(options.locale, { style: "currency", currency: options.currency });
    } catch (error) {
      // A missing or empty currency is a caller's bug and still throws.
      if (typeof options.currency !== "string" || options.currency === "") throw error;
      // An ill-formed stored currency code (#652): the amount with its code, never an exception.
      const decimals = currencyDecimals(options.currency);
      const plain = new Intl.NumberFormat(options.locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      return `${plain.format(cents / 10 ** decimals)} ${options.currency}`;
    }
    formatterCache.set(cacheKey, formatter);
  }
  return formatter.format(cents / 10 ** currencyDecimals(options.currency));
}
