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

  it("refuses a non-zero decimal beyond the currency's with too_many_decimals, never rounding it", () => {
    const tooManyDecimals = (decimals: number, currency: string) => (error: unknown) =>
      isValidationError(error, "too_many_decimals") &&
      error.details.decimals === decimals &&
      error.details.currency === currency &&
      Object.keys(error.details).length === 2;
    // 1.005 would round to 101 cents (or, in floating point, to 100): neither, it is refused.
    assert.throws(() => scaleDecimalAmount("1.005", "EUR"), tooManyDecimals(2, "EUR"));
    assert.throws(() => scaleDecimalAmount("-12.344", "EUR"), tooManyDecimals(2, "EUR"));
    assert.throws(() => scaleDecimalAmount("12.3400001", "EUR"), tooManyDecimals(2, "EUR"));
    assert.throws(() => scaleDecimalAmount("1000.5", "JPY"), tooManyDecimals(0, "JPY"));
    assert.throws(() => scaleDecimalAmount("1.250", "JPY"), tooManyDecimals(0, "JPY"));
    assert.throws(() => scaleDecimalAmount("0.0004", "KWD"), tooManyDecimals(3, "KWD"));
    assert.throws(() => scaleDecimalAmount("-0.004", "EUR"), tooManyDecimals(2, "EUR"));
  });

  it("refuses a long run of decimals quickly and without echoing it", () => {
    const text = `1.${"0".repeat(1_000_000)}1`;
    const started = performance.now();
    assert.throws(
      () => scaleDecimalAmount(text, "EUR"),
      (error: unknown) =>
        isValidationError(error, "too_many_decimals") && JSON.stringify(error.details).length < 100 && error.message.length < 200,
    );
    assert.ok(performance.now() - started < 500);
    assert.equal(scaleDecimalAmount(`1.${"0".repeat(1_000_000)}`, "EUR"), 100);
  });

  it("never returns -0", () => {
    assert.ok(Object.is(scaleDecimalAmount("-0", "EUR"), 0));
    assert.ok(Object.is(scaleDecimalAmount("-0.00", "EUR"), 0));
    assert.ok(Object.is(scaleDecimalAmount("-0.0000", "EUR"), 0));
    assert.ok(Object.is(scaleDecimalAmount("-0.0", "JPY"), 0));
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
    // Leading zeros are not digits of the amount.
    assert.equal(scaleDecimalAmount(`${"0".repeat(50)}1000000000000`, "JPY"), MAX_AMOUNT_CENTS);
    // Far beyond the safe range of a double: still refused as too large, never read inexactly.
    assert.throws(() => scaleDecimalAmount("-123456789012345678901234567890", "JPY"), tooLarge);
  });

  it("refuses a million-digit amount quickly, with details that stay small (security)", () => {
    const text = "9".repeat(1_000_000);
    const started = performance.now();
    assert.throws(
      () => scaleDecimalAmount(text, "EUR"),
      (error: unknown) =>
        isValidationError(error, "amount_too_large") &&
        error.details.max === MAX_AMOUNT_CENTS &&
        JSON.stringify(error.details).length < 100 &&
        error.message.length < 200,
    );
    // Reading it with BigInt took over a second; bounding the digits first takes none.
    assert.ok(performance.now() - started < 500);
  });

  it("echoes the amount read when it is short enough to be read", () => {
    assert.throws(
      () => scaleDecimalAmount("-10000000000.01", "EUR"),
      (error: unknown) => isValidationError(error, "amount_too_large") && error.details.value === "-1000000000001",
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

  it("names the file's currency only when it has the shape of a currency code (security)", () => {
    const unknown = (error: unknown) =>
      isValidationError(error, "currency_mismatch") &&
      error.details.accountCurrency === "EUR" &&
      Object.keys(error.details).length === 1 &&
      error.message.length < 200;
    assert.throws(() => assertFileCurrency("X".repeat(1_000_000), "EUR"), unknown);
    assert.throws(() => assertFileCurrency("US1", "EUR"), unknown);
    assert.throws(() => assertFileCurrency("€", "EUR"), unknown);
    assert.throws(() => assertFileCurrency("EURO", "EUR"), unknown);
    assert.throws(() => assertFileCurrency("U S", "EUR"), unknown);
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
