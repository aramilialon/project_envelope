import { formatMoney, isValidationError, MAX_AMOUNT_CENTS } from "@envelope/core";
import type { IntlShape } from "react-intl";

import { ApiError } from "./apiFetch.ts";

/**
 * Whether an error is the cap on a single amount (#651, ADR 0002): `parseAmount` refusing what
 * the user typed, or the API answering 400 `amount_too_large` (for example for a file's row).
 */
export function isAmountTooLarge(error: unknown): boolean {
  return isValidationError(error, "amount_too_large") || (error instanceof ApiError && error.code === "amount_too_large");
}

/** The message for an amount above the cap, with the cap in the workspace's currency. */
export function amountTooLargeMessage(intl: IntlShape, currency: string): string {
  return intl.formatMessage(
    { id: "common.error.amountTooLarge", defaultMessage: "An amount is too large: a single amount can be up to {max}." },
    { max: formatMoney(MAX_AMOUNT_CENTS, { locale: intl.locale, currency }) },
  );
}
