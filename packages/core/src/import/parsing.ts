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

/** The most integer digits an amount can have in any currency: `MAX_AMOUNT_CENTS` in a currency without decimals. */
const MAX_INTEGER_DIGITS = String(MAX_AMOUNT_CENTS).length;

/**
 * A plain decimal number ("-1234.5", "1500", "0.125") in the minor units of
 * `currency`, exactly, without floating point (ADR 0002, #671): "1000" is
 * 100000 cents in EUR, 1000 yen in JPY and 1000000 fils in KWD.
 *
 * An imported amount is a fact about the bank's own record, so it is never
 * rounded: decimals beyond the currency's own must be zeros ("1500.00" in JPY
 * is 1500 yen, "42.5000" in EUR is 4250 cents), and any other is refused,
 * since the amount was misread (a wrong decimal separator, or a file from an
 * account in another currency). Never returns -0.
 *
 * Returns null for text that is not `-?digits(.digits)?`.
 *
 * @throws ValidationError "too_many_decimals" (details: decimals, currency) for
 *   a non-zero digit beyond the currency's decimals; "amount_too_large"
 *   (details: label, max, and value when the text is short enough to be read)
 *   beyond `MAX_AMOUNT_CENTS`, however many digits the text has. Neither echoes
 *   the text, which can be as long as the file.
 */
export function scaleDecimalAmount(text: string, currency: CurrencyCode): Cents | null {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;
  const [, minus, digits = "0", fractionDigits = ""] = match;
  // Bound the digits before BigInt: a file's amount can be a million digits long, and reading
  // or echoing it whole would block the process (and fill the reply) for nothing.
  const integerDigits = digits.replace(/^0+/, "");
  if (integerDigits.length > MAX_INTEGER_DIGITS) {
    throw new ValidationError("amount_too_large", `amount is beyond ${MAX_AMOUNT_CENTS} minor units`, {
      label: "amount",
      max: MAX_AMOUNT_CENTS,
    });
  }
  const decimals = currencyDecimals(currency);
  if (/[1-9]/.test(fractionDigits.slice(decimals))) {
    throw new ValidationError("too_many_decimals", `an amount in ${currency} has at most ${decimals} decimals`, {
      decimals,
      currency,
    });
  }
  const kept = fractionDigits.slice(0, decimals).padEnd(decimals, "0");
  const magnitude = BigInt(integerDigits + kept);
  if (magnitude > BigInt(MAX_AMOUNT_CENTS)) {
    // At most MAX_INTEGER_DIGITS plus the currency's decimals: short enough to echo.
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
 * @throws ValidationError with code "invalid_amount_format", "too_many_decimals", or
 *   "amount_too_large" beyond `MAX_AMOUNT_CENTS` (ADR 0002).
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
 * @throws ValidationError "currency_mismatch" (details: fileCurrency, accountCurrency). The
 *   file's value is echoed only when it has the shape of a currency code (three letters);
 *   anything else is refused with `accountCurrency` alone, since it can be as long as the file.
 */
export function assertFileCurrency(fileCurrency: string | undefined, accountCurrency: CurrencyCode): void {
  if (fileCurrency === undefined) return;
  // An ISO 4217 code: OFX 1.x is not case-sensitive, and surrounding spaces are not part of it.
  const stated = fileCurrency.trim().toUpperCase();
  if (stated === "" || stated === accountCurrency) return;
  if (!/^[A-Z]{3}$/.test(stated)) {
    throw new ValidationError("currency_mismatch", `the file states no recognizable currency, the account is in ${accountCurrency}`, {
      accountCurrency,
    });
  }
  throw new ValidationError("currency_mismatch", `the file is in ${stated}, the account in ${accountCurrency}`, {
    fileCurrency: stated,
    accountCurrency,
  });
}

/** Which of two numbered date fields is the day and which is the month, given the format's own order. */
export function swapDayMonth(first: string, second: string, dayFirst: boolean): { day: string; month: string } {
  return dayFirst ? { day: first, month: second } : { day: second, month: first };
}
