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
 * Checks that a value is a valid amount: a "safe" integer, meaning it can be
 * represented without losing precision (up to about 90 trillion euros).
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

/** Adds up a list of amounts, validating each one. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    assertCents(value);
    total += value;
  }
  assertCents(total, "total");
  return total;
}

/** Number of decimals of a currency: 2 for EUR, 0 for JPY, 3 for KWD. */
export function currencyDecimals(currency: CurrencyCode): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

interface Separators {
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
 * @throws ValidationError with code "invalid_amount_format".
 */
export function parseAmount(text: string, options: { locale: Locale; currency: CurrencyCode }): Cents {
  const { group, decimal } = separatorsFor(options.locale);
  const decimals = currencyDecimals(options.currency);
  const g = groupPattern(group);
  const d = escapeRegExp(decimal);
  const fraction = decimals > 0 ? `(?:${d}(\\d{1,${decimals}}))?` : "()";
  const pattern = new RegExp(`^(-)?(\\d{1,3}(?:${g}\\d{3})+|\\d+)${fraction}$`);

  const match = pattern.exec(text.trim());
  if (match === null) {
    throw new ValidationError("invalid_amount_format", `not a valid amount for ${options.locale}: "${text}"`, {
      text,
      locale: options.locale,
    });
  }
  const [, minus, integerPart = "0", fractionPart = ""] = match;
  const whole = Number(integerPart.replace(new RegExp(g, "g"), ""));
  const minor = decimals > 0 ? Number(fractionPart.padEnd(decimals, "0")) : 0;
  const result = whole * 10 ** decimals + minor;
  assertCents(result);
  // "-0" would become -0: normalize it to 0.
  return minus === undefined || result === 0 ? result : -result;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

/**
 * Formats an amount for display, in the user's locale.
 *
 * @example formatMoney(123456, { locale: "en-US", currency: "EUR" }) // "€1,234.56"
 * @example formatMoney(123456, { locale: "it-IT", currency: "EUR" }) // "1234,56 €" (non-breaking space)
 */
export function formatMoney(cents: Cents, options: { locale: Locale; currency: CurrencyCode }): string {
  assertCents(cents);
  const cacheKey = `${options.locale}|${options.currency}`;
  let formatter = formatterCache.get(cacheKey);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(options.locale, { style: "currency", currency: options.currency });
    formatterCache.set(cacheKey, formatter);
  }
  return formatter.format(cents / 10 ** currencyDecimals(options.currency));
}
