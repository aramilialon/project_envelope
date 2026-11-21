import { MAX_AMOUNT_CENTS, parseAmount } from "@envelope/core";
import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { ApiError } from "./apiFetch.ts";
import { amountTooLargeMessage, isAmountTooLarge } from "./amountTooLarge.ts";
import { AMOUNT_TOO_LARGE_EUR, typedAmount } from "./test-utils.tsx";

describe("the cap on a single amount (#651)", () => {
  const intl = createIntl({ locale: "en", defaultLocale: "en" });

  it("recognises parseAmount's refusal and the API's 400 amount_too_large, and nothing else", () => {
    let parsed: unknown;
    try {
      parseAmount(typedAmount(MAX_AMOUNT_CENTS + 1), { locale: "en", currency: "EUR" });
    } catch (caught) {
      parsed = caught;
    }
    expect(isAmountTooLarge(parsed)).toBe(true);
    expect(isAmountTooLarge(new ApiError("failed", 400, "amount_too_large", { max: MAX_AMOUNT_CENTS }))).toBe(true);
    expect(isAmountTooLarge(new ApiError("failed", 400, "invalid_amount", {}))).toBe(false);
    expect(isAmountTooLarge(new Error("amount_too_large"))).toBe(false);
  });

  it("names the cap in the workspace's currency, in minor units of that currency", () => {
    expect(amountTooLargeMessage(intl, "EUR")).toBe(AMOUNT_TOO_LARGE_EUR);
    // The same number of minor units: yen have none below the unit, so the cap reads 100 times larger.
    const yen = new Intl.NumberFormat("en").format(MAX_AMOUNT_CENTS);
    expect(amountTooLargeMessage(intl, "JPY")).toBe(`An amount is too large: a single amount can be up to ¥${yen}.`);
  });
});
