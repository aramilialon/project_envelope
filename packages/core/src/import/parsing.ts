/**
 * Parsing building blocks shared by the import formats: reading a decimal
 * amount into the account currency's minor units and checking the currency a
 * file states (every format), and the pieces for the formats whose decimal
 * separator and day/month order are not standardized (CSV, QIF) — unlike OFX
 * and CAMT.053, which are self-describing and always use "." as the decimal
 * separator.
 */

import { ValidationError } from "../errors.ts";
import { assertAmount, currencyDecimals, MAX_AMOUNT_CENTS, type Cents, type CurrencyCode } from "../money.ts";

/**
 * A plain decimal number ("-1234.5", "1500", "0.125") in the minor units of
 * `currency`, exactly, without floating point (ADR 0002, #671): "1000" is
 * 100000 cents in EUR, 1000 yen in JPY and 1000000 fils in KWD.
 *
 * Decimals beyond the currency's own are rounded half away from zero, to the
 * minor unit, the rule for any conversion to an amount (ADR 0011): "12.345"
 * in EUR is 1235 cents, "-12.345" is -1235, "12.344" is 1234, and "1000.5" in
 * JPY is 1001 yen. Trailing zeros are never a rounding: "1500.00" in JPY is
 * 1500 yen. Never returns -0.
 *
 * Returns null for text that is not `-?digits(.digits)?`.
 *
 * @throws ValidationError "amount_too_large" (details: label, max, value) beyond
 *   `MAX_AMOUNT_CENTS`, however many digits the text has.
 */
export function scaleDecimalAmount(text: string, currency: CurrencyCode): Cents | null {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;
  const [, minus, integerDigits = "0", fractionDigits = ""] = match;
  const decimals = currencyDecimals(currency);
  const kept = fractionDigits.slice(0, decimals).padEnd(decimals, "0");
  const firstDropped = fractionDigits[decimals];
  const roundsUp = firstDropped !== undefined && firstDropped >= "5";
  const magnitude = BigInt(integerDigits + kept) + (roundsUp ? 1n : 0n);
  if (magnitude > BigInt(MAX_AMOUNT_CENTS)) {
    // Too many digits to be exact is too large too: the cap is far inside the safe range.
    const value = minus === undefined ? magnitude : -magnitude;
    throw new ValidationError("amount_too_large", `amount is beyond ${MAX_AMOUNT_CENTS} minor units: ${value}`, {
      label: "amount",
      max: MAX_AMOUNT_CENTS,
      value: String(value),
    });
  }
  const amount = Number(magnitude);
  const result = minus === undefined || amount === 0 ? amount : -amount;
  assertAmount(result);
  return result;
}

/**
 * An amount using either "." or "," as the decimal separator, with the other
 * character (when present) as a thousands group separator, in the minor
 * units of `currency` (`scaleDecimalAmount`).
 *
 * @throws ValidationError with code "invalid_amount_format", or "amount_too_large" beyond
 *   `MAX_AMOUNT_CENTS` (ADR 0002).
 */
export function parseDecimalAmount(
  text: string,
  decimalSeparator: "." | ",",
  currency: CurrencyCode,
  errorPrefix = "not a valid amount",
): Cents {
  const trimmed = text.trim();
  const groupSeparator = decimalSeparator === "." ? "," : ".";
  const withoutGroups = trimmed.split(groupSeparator).join("");
  const normalized = decimalSeparator === "," ? withoutGroups.replace(",", ".") : withoutGroups;
  const amount = scaleDecimalAmount(normalized, currency);
  if (amount === null) {
    throw new ValidationError("invalid_amount_format", `${errorPrefix}: "${text}"`, { text });
  }
  return amount;
}

/**
 * Refuses a file that states a currency other than the account's (#672): its
 * amounts would otherwise go into the account as if they were in the
 * account's currency. A file that states none (CSV, QIF, or an OFX or
 * CAMT.053 file without one) is read in the account's currency.
 *
 * @throws ValidationError "currency_mismatch" (details: fileCurrency, accountCurrency).
 */
export function assertFileCurrency(fileCurrency: string | undefined, accountCurrency: CurrencyCode): void {
  if (fileCurrency === undefined) return;
  // An ISO 4217 code: OFX 1.x is not case-sensitive, and surrounding spaces are not part of it.
  const stated = fileCurrency.trim().toUpperCase();
  if (stated === "" || stated === accountCurrency) return;
  throw new ValidationError("currency_mismatch", `the file is in ${stated}, the account in ${accountCurrency}`, {
    fileCurrency: stated,
    accountCurrency,
  });
}

/** Which of two numbered date fields is the day and which is the month, given the format's own order. */
export function swapDayMonth(first: string, second: string, dayFirst: boolean): { day: string; month: string } {
  return dayFirst ? { day: first, month: second } : { day: second, month: first };
}
