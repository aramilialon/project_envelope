import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { MAX_AMOUNT_CENTS } from "../money.ts";
import { assertFileCurrency, parseDecimalAmount, scaleDecimalAmount } from "./parsing.ts";

describe("scaleDecimalAmount (#671)", () => {
  it("scales by the currency's own decimals: 2 for EUR, 0 for JPY, 3 for KWD", () => {
    assert.equal(scaleDecimalAmount("1000", "EUR"), 100_000);
    assert.equal(scaleDecimalAmount("1000", "JPY"), 1000);
    assert.equal(scaleDecimalAmount("1000", "KWD"), 1_000_000);
    assert.equal(scaleDecimalAmount("1.5", "EUR"), 150);
    assert.equal(scaleDecimalAmount("1.500", "KWD"), 1500);
    assert.equal(scaleDecimalAmount("1.5", "KWD"), 1500);
    assert.equal(scaleDecimalAmount("0.001", "KWD"), 1);
    assert.equal(scaleDecimalAmount("-42.50", "EUR"), -4250);
    assert.equal(scaleDecimalAmount("-1500", "JPY"), -1500);
    assert.equal(scaleDecimalAmount("-0.125", "KWD"), -125);
  });

  it("drops trailing zeros beyond the currency's decimals without rounding", () => {
    assert.equal(scaleDecimalAmount("1500.00", "JPY"), 1500);
    assert.equal(scaleDecimalAmount("42.5000", "EUR"), 4250);
    assert.equal(scaleDecimalAmount("2.1250", "KWD"), 2125);
  });

  it("rounds further decimals half away from zero, exactly, at every scale", () => {
    // 1.005 * 100 is 100.49999999999999 in floating point: the exact reading rounds it up.
    assert.equal(scaleDecimalAmount("1.005", "EUR"), 101);
    assert.equal(scaleDecimalAmount("-1.005", "EUR"), -101);
    assert.equal(scaleDecimalAmount("12.344", "EUR"), 1234);
    assert.equal(scaleDecimalAmount("12.3449", "EUR"), 1234);
    assert.equal(scaleDecimalAmount("12.345", "EUR"), 1235);
    assert.equal(scaleDecimalAmount("-12.345", "EUR"), -1235);
    assert.equal(scaleDecimalAmount("1000.4", "JPY"), 1000);
    assert.equal(scaleDecimalAmount("1000.5", "JPY"), 1001);
    assert.equal(scaleDecimalAmount("-1000.5", "JPY"), -1001);
    assert.equal(scaleDecimalAmount("0.0005", "KWD"), 1);
    assert.equal(scaleDecimalAmount("0.0004", "KWD"), 0);
    assert.equal(scaleDecimalAmount("9.9995", "KWD"), 10_000);
  });

  it("never returns -0", () => {
    assert.ok(Object.is(scaleDecimalAmount("-0", "EUR"), 0));
    assert.ok(Object.is(scaleDecimalAmount("-0.00", "EUR"), 0));
    assert.ok(Object.is(scaleDecimalAmount("-0.004", "EUR"), 0));
    assert.ok(Object.is(scaleDecimalAmount("-0.4", "JPY"), 0));
  });

  it("returns null for text that is not a plain decimal number", () => {
    for (const text of ["", "-", "1.", ".5", "1,5", "1e3", "+1", " 1", "1.2.3", "0x10", "Infinity"]) {
      assert.equal(scaleDecimalAmount(text, "EUR"), null, text);
    }
  });

  it("reads the cap in every currency and refuses one minor unit more, however many digits", () => {
    assert.equal(scaleDecimalAmount("10000000000.00", "EUR"), MAX_AMOUNT_CENTS);
    assert.equal(scaleDecimalAmount("-1000000000000", "JPY"), -MAX_AMOUNT_CENTS);
    assert.equal(scaleDecimalAmount("1000000000.000", "KWD"), MAX_AMOUNT_CENTS);
    const tooLarge = (error: unknown) => isValidationError(error, "amount_too_large") && error.details.max === MAX_AMOUNT_CENTS;
    assert.throws(() => scaleDecimalAmount("10000000000.01", "EUR"), tooLarge);
    assert.throws(() => scaleDecimalAmount("1000000000001", "JPY"), tooLarge);
    assert.throws(() => scaleDecimalAmount("1000000000.001", "KWD"), tooLarge);
    // Rounding up to one past the cap is past the cap.
    assert.throws(() => scaleDecimalAmount("10000000000.005", "EUR"), tooLarge);
    // Far beyond the safe range of a double: still refused as too large, never read inexactly.
    assert.throws(
      () => scaleDecimalAmount("-123456789012345678901234567890", "JPY"),
      (error: unknown) => isValidationError(error, "amount_too_large") && error.details.value === "-123456789012345678901234567890",
    );
  });
});

describe("parseDecimalAmount (#671)", () => {
  it("reads grouped amounts with either separator in the currency's minor units", () => {
    assert.equal(parseDecimalAmount("1,000", ".", "JPY"), 1000);
    assert.equal(parseDecimalAmount("1.000", ",", "JPY"), 1000);
    assert.equal(parseDecimalAmount("1.234,567", ",", "KWD"), 1_234_567);
    assert.equal(parseDecimalAmount("-1,234.567", ".", "KWD"), -1_234_567);
    assert.equal(parseDecimalAmount(" 1,234.56 ", ".", "EUR"), 123_456);
  });

  it("refuses text that is not an amount with invalid_amount_format", () => {
    assert.throws(
      () => parseDecimalAmount("12 euro", ".", "EUR"),
      (error: unknown) => isValidationError(error, "invalid_amount_format") && error.details.text === "12 euro",
    );
  });
});

describe("assertFileCurrency (#672)", () => {
  it("accepts a file that states no currency, or the account's own", () => {
    assert.doesNotThrow(() => assertFileCurrency(undefined, "EUR"));
    assert.doesNotThrow(() => assertFileCurrency("", "EUR"));
    assert.doesNotThrow(() => assertFileCurrency("EUR", "EUR"));
    assert.doesNotThrow(() => assertFileCurrency(" eur ", "EUR"));
  });

  it("refuses any other currency with currency_mismatch and both codes in details", () => {
    assert.throws(
      () => assertFileCurrency("usd", "EUR"),
      (error: unknown) =>
        isValidationError(error, "currency_mismatch") &&
        error.details.fileCurrency === "USD" &&
        error.details.accountCurrency === "EUR" &&
        Object.keys(error.details).length === 2,
    );
  });
});
