/**
 * Parsing building blocks shared by the bank-export formats whose decimal
 * separator and day/month order are not standardized (CSV, QIF) — unlike
 * OFX and CAMT.053, which are self-describing and use their own, unrelated
 * amount format.
 */

import { ValidationError } from "../errors.ts";
import { assertCents, type Cents } from "../money.ts";

/**
 * An amount using either "." or "," as the decimal separator, with the other
 * character (when present) as a thousands group separator.
 *
 * @throws ValidationError with code "invalid_amount_format".
 */
export function parseDecimalAmount(
  text: string,
  decimalSeparator: "." | ",",
  errorPrefix = "not a valid amount",
): Cents {
  const trimmed = text.trim();
  const groupSeparator = decimalSeparator === "." ? "," : ".";
  const withoutGroups = trimmed.split(groupSeparator).join("");
  const normalized = decimalSeparator === "," ? withoutGroups.replace(",", ".") : withoutGroups;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new ValidationError("invalid_amount_format", `${errorPrefix}: "${text}"`, { text });
  }
  const cents = Math.round(Number(normalized) * 100);
  assertCents(cents);
  return cents;
}

/** Which of two numbered date fields is the day and which is the month, given the format's own order. */
export function swapDayMonth(first: string, second: string, dayFirst: boolean): { day: string; month: string } {
  return dayFirst ? { day: first, month: second } : { day: second, month: first };
}
