import { isValidationError } from "../errors.ts";
import type { Cents, CurrencyCode, Locale } from "../money.ts";
import { MAX_AMOUNT_CENTS, parseAmount } from "../money.ts";

/**
 * What an entry typed in a category's "Assigned this month" field means (#698): a new assigned
 * amount (`300`) or a change to the current one (`+50`, `-15`).
 *
 * - `delta`: what to assign (positive) or take back to "Unassigned" (negative); `0` when the entry
 *   changes nothing, which is then sent nowhere.
 * - `newAssigned`: the assigned amount once `delta` is applied.
 * - `isAbsolute`: whether the entry named the new amount itself rather than a change, so that a
 *   caller can tell "set it to 300" (which someone else's change in the meantime would conflict
 *   with) from "add 50" (which it would not).
 */
export type AssignedEntry =
  | { readonly ok: true; readonly delta: Cents; readonly newAssigned: Cents; readonly isAbsolute: boolean }
  | { readonly ok: false; readonly code: AssignedEntryErrorCode };

/**
 * - `"invalid_amount_format"`: not an amount in the locale, an empty entry or a lone sign included.
 * - `"amount_too_large"`: the amount typed, the resulting assigned amount or the change to it is
 *   beyond `MAX_AMOUNT_CENTS` (ADR 0002). A result beyond the cap is still accepted when it is
 *   closer to zero than the current amount (one stored before the cap, being brought down).
 */
export type AssignedEntryErrorCode = "invalid_amount_format" | "amount_too_large";

/**
 * Parses an entry typed in a category's "Assigned this month" field against the category's
 * current assigned amount, following the locale's separators. A leading `+` or `-` makes the
 * entry a change to the current amount; anything else is the new amount itself.
 */
export function parseAssignedEntry(
  text: string,
  assigned: Cents,
  options: { readonly locale: Locale; readonly currency: CurrencyCode },
): AssignedEntry {
  const trimmed = text.trim();
  const sign = trimmed.startsWith("+") ? 1 : trimmed.startsWith("-") ? -1 : 0;
  const body = sign === 0 ? trimmed : trimmed.slice(1).trim();
  // "+-5" or "--5": the sign belongs to the entry, the number after it has none of its own.
  if (body === "" || body.startsWith("+") || body.startsWith("-")) {
    return { ok: false, code: "invalid_amount_format" };
  }
  let magnitude: Cents;
  try {
    magnitude = parseAmount(body, { locale: options.locale, currency: options.currency });
  } catch (error) {
    if (isValidationError(error, "amount_too_large")) {
      return { ok: false, code: "amount_too_large" };
    }
    if (isValidationError(error, "invalid_amount_format")) {
      return { ok: false, code: "invalid_amount_format" };
    }
    throw error;
  }
  const newAssigned = sign === 0 ? magnitude : assigned + sign * magnitude;
  const delta = newAssigned - assigned;
  const resultTooLarge = Math.abs(newAssigned) > MAX_AMOUNT_CENTS && Math.abs(newAssigned) >= Math.abs(assigned);
  if (resultTooLarge || Math.abs(delta) > MAX_AMOUNT_CENTS) {
    return { ok: false, code: "amount_too_large" };
  }
  return { ok: true, delta, newAssigned, isAbsolute: sign === 0 };
}
