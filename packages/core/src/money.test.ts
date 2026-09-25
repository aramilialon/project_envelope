import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import { assertCents, currencyDecimals, formatMoney, parseAmount, sumCents } from "./money.ts";

const IT_EUR = { locale: "it-IT", currency: "EUR" };
const US_USD = { locale: "en-US", currency: "USD" };

describe("parseAmount", () => {
  it("reads Italian-formatted amounts", () => {
    assert.equal(parseAmount("12", IT_EUR), 1200);
    assert.equal(parseAmount("12,5", IT_EUR), 1250);
    assert.equal(parseAmount("12,50", IT_EUR), 1250);
    assert.equal(parseAmount("0,07", IT_EUR), 7);
    assert.equal(parseAmount("1.234,56", IT_EUR), 123456);
    assert.equal(parseAmount("1234,56", IT_EUR), 123456);
    assert.equal(parseAmount(" 3,20 ", IT_EUR), 320);
  });

  it("reads US-formatted amounts", () => {
    assert.equal(parseAmount("1,234.56", US_USD), 123456);
    assert.equal(parseAmount("1234.5", US_USD), 123450);
  });

  it("accepts the spaces and apostrophes people actually type as group separators", () => {
    const fr = { locale: "fr-FR", currency: "EUR" };
    assert.equal(parseAmount("1 234,56", fr), 123456); // regular space
    assert.equal(parseAmount("1\u202f234,56", fr), 123456); // narrow non-breaking space
    const ch = { locale: "de-CH", currency: "CHF" };
    assert.equal(parseAmount("1'234.56", ch), 123456);
    assert.equal(parseAmount("1\u2019234.56", ch), 123456);
  });

  it("respects the number of decimals of the currency", () => {
    assert.equal(parseAmount("1,235", { locale: "en-US", currency: "JPY" }), 1235);
    assert.throws(() => parseAmount("12.5", { locale: "en-US", currency: "JPY" }));
    assert.equal(parseAmount("1.234", { locale: "en-US", currency: "KWD" }), 1234);
  });

  it("handles negative amounts", () => {
    assert.equal(parseAmount("-3,20", IT_EUR), -320);
    assert.equal(parseAmount("-0", IT_EUR), 0);
  });

  it("rejects formats that do not match the locale", () => {
    for (const text of ["12.5", "12,345", "1,234.56", "12.34.5", "abc", "", "1.23,4"]) {
      assert.throws(
        () => parseAmount(text, IT_EUR),
        (error) => isValidationError(error, "invalid_amount_format"),
        `"${text}" should have been rejected`,
      );
    }
  });
});

describe("formatMoney", () => {
  it("formats according to the locale", () => {
    // Intl puts a non-breaking space (\u00a0) before the € sign in Italian and German.
    assert.equal(formatMoney(1234567, IT_EUR), "12.345,67\u00a0€");
    assert.equal(formatMoney(123456, { locale: "de-DE", currency: "EUR" }), "1.234,56\u00a0€");
    assert.equal(formatMoney(123456, { locale: "en-US", currency: "EUR" }), "€1,234.56");
    assert.equal(formatMoney(-320, US_USD), "-$3.20");
  });

  it("uses the minor unit of the currency", () => {
    assert.equal(formatMoney(1235, { locale: "en-US", currency: "JPY" }), "¥1,235");
  });
});

describe("currencyDecimals", () => {
  it("knows how many decimals each currency has", () => {
    assert.equal(currencyDecimals("EUR"), 2);
    assert.equal(currencyDecimals("JPY"), 0);
    assert.equal(currencyDecimals("KWD"), 3);
  });
});

describe("assertCents and sumCents", () => {
  it("accept only safe integers", () => {
    assert.doesNotThrow(() => assertCents(100));
    for (const value of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => assertCents(value), (error) => isValidationError(error, "invalid_amount"));
    }
  });

  it("add up without rounding errors", () => {
    // €0.10 + €0.20 = €0.30 exactly: with decimals it would be 0.30000000000000004
    assert.equal(sumCents([10, 20]), 30);
    assert.equal(sumCents([]), 0);
  });
});
