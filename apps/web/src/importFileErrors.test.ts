import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { ApiError } from "./apiFetch.ts";
import { currencyLabel, currencyMismatchMessage, isCurrencyMismatch, isTooManyDecimals, tooManyDecimalsMessage } from "./importFileErrors.ts";

describe("an imported file's currency and decimals (#671, #672)", () => {
  const intl = createIntl({ locale: "en", defaultLocale: "en" });

  it("names a currency in the interface language, then its code, or by its code alone", () => {
    expect(currencyLabel(intl, "USD")).toBe("US Dollar (USD)");
    expect(currencyLabel(createIntl({ locale: "it", defaultLocale: "en" }), "USD")).toBe("dollaro statunitense (USD)");
    // A well-formed code the runtime has no name for, and an ill-formed one.
    expect(currencyLabel(intl, "XYZ")).toBe("XYZ");
    expect(currencyLabel(intl, "12")).toBe("12");
  });

  it("recognises only its own refusals", () => {
    expect(isCurrencyMismatch(new ApiError("400", 400, "currency_mismatch", {}))).toBe(true);
    expect(isTooManyDecimals(new ApiError("400", 400, "too_many_decimals", {}))).toBe(true);
    expect(isCurrencyMismatch(new ApiError("400", 400, "too_many_decimals", {}))).toBe(false);
    expect(isTooManyDecimals(new Error("too_many_decimals"))).toBe(false);
  });

  it("falls back to the unrecognized-currency message for a file currency that is not a code", () => {
    const caught = new ApiError("400", 400, "currency_mismatch", { fileCurrency: "dollars", accountCurrency: "EUR" });
    expect(currencyMismatchMessage(intl, caught, "EUR")).toBe(
      "A file can be imported only into an account in the same currency: this file states a currency we don't recognize, and this account's is Euro (EUR).",
    );
  });

  it("writes the currency's decimals as a plural, and takes them from the currency when the reply has none", () => {
    const message = (details: Record<string, string | number>) =>
      tooManyDecimalsMessage(intl, new ApiError("400", 400, "too_many_decimals", details), "KWD", "file");
    expect(message({ decimals: 3, currency: "KWD" })).toMatch(/^An amount in Kuwaiti Dinar \(KWD\) can have at most 3 decimal places:/);
    expect(message({ decimals: 1, currency: "XYZ" })).toMatch(/^An amount in XYZ can have at most 1 decimal place:/);
    expect(message({ decimals: 0, currency: "JPY" })).toMatch(/^An amount in Japanese Yen \(JPY\) can't have decimal places:/);
    expect(message({})).toMatch(/^An amount in Kuwaiti Dinar \(KWD\) can have at most 3 decimal places:/);
  });
});
