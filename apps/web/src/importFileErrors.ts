import { currencyDecimals } from "@envelope/core";
import type { IntlShape } from "react-intl";

import { ApiError } from "./apiFetch.ts";

/**
 * A currency as the import's refusals name it (#671, #672): its name in the interface language,
 * then its code ("US Dollar (USD)"), so a reader who does not know the code still knows the
 * currency. The code alone when the runtime has no name for it, or none but the code itself.
 */
export function currencyLabel(intl: IntlShape, code: string): string {
  try {
    // The interface language (`IntlProvider`'s locale), not the formatting locale: this is a word.
    const name = new Intl.DisplayNames([intl.locale], { type: "currency" }).of(code);
    return name === undefined || name === code ? code : `${name} (${code})`;
  } catch {
    return code;
  }
}

/** Whether `caught` is the API refusing a file stating another currency than the account's (#672). */
export function isCurrencyMismatch(caught: unknown): caught is ApiError {
  return caught instanceof ApiError && caught.code === "currency_mismatch";
}

/** Whether `caught` is the API refusing an amount with more decimals than its currency has (#671). */
export function isTooManyDecimals(caught: unknown): caught is ApiError {
  return caught instanceof ApiError && caught.code === "too_many_decimals";
}

/**
 * The message for a file refused as in another currency than the account's (#672). The API names
 * the file's currency only when it is a three-letter code; otherwise the message says the file's
 * currency is not recognized. `accountCurrency` is the screen's own, should the reply lack it.
 */
export function currencyMismatchMessage(intl: IntlShape, caught: ApiError, accountCurrency: string): string {
  const account = currencyLabel(intl, String(caught.details.accountCurrency ?? accountCurrency));
  const file = caught.details.fileCurrency;
  if (typeof file === "string" && /^[A-Z]{3}$/.test(file)) {
    return intl.formatMessage(
      {
        id: "import.error.currencyMismatch",
        defaultMessage:
          "A file can be imported only into an account in the same currency: this file's currency is {fileCurrency}, and this account's is {accountCurrency}.",
      },
      { fileCurrency: currencyLabel(intl, file), accountCurrency: account },
    );
  }
  return intl.formatMessage(
    {
      id: "import.error.currencyMismatchUnknown",
      defaultMessage:
        "A file can be imported only into an account in the same currency: this file states a currency we don't recognize, and this account's is {accountCurrency}.",
    },
    { accountCurrency: account },
  );
}

/**
 * The message for an amount with more decimals than its currency has (#671). `separator` is the
 * CSV's own step 2, where the decimal separator was chosen by hand and may be the wrong one; the
 * other formats (QIF, OFX, CAMT.053) are refused at step 1. `accountCurrency` is the screen's own,
 * should the reply lack the currency or its decimals.
 */
export function tooManyDecimalsMessage(
  intl: IntlShape,
  caught: ApiError,
  accountCurrency: string,
  where: "separator" | "file",
): string {
  const code = String(caught.details.currency ?? accountCurrency);
  const fromReply = Number(caught.details.decimals);
  const decimals = Number.isInteger(fromReply) && fromReply >= 0 ? fromReply : currencyDecimals(code);
  const values = { currency: currencyLabel(intl, code), decimals };
  return where === "separator"
    ? intl.formatMessage(
        {
          id: "import.error.tooManyDecimalsSeparator",
          defaultMessage:
            "An amount in {currency} {decimals, plural, =0 {can't have decimal places} one {can have at most # decimal place} other {can have at most # decimal places}}: this file has an amount with more, so it was not imported. The decimal separator chosen may not be the file's, or the file may be from an account in another currency.",
        },
        values,
      )
    : intl.formatMessage(
        {
          id: "import.error.tooManyDecimals",
          defaultMessage:
            "An amount in {currency} {decimals, plural, =0 {can't have decimal places} one {can have at most # decimal place} other {can have at most # decimal places}}: this file has an amount with more, so it was not imported. The file may be from an account in another currency.",
        },
        values,
      );
}

