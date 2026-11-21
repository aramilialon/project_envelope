import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import { assertCents, assertKnownCurrency, currencyDecimals, formatMoney, isKnownCurrency, parseAmount, sumCents } from "./money.ts";

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

describe("formatMoney and parseAmount in the next interface languages (#620)", () => {
  const DE_EUR = { locale: "de-DE", currency: "EUR" };
  const ES_EUR = { locale: "es-ES", currency: "EUR" };
  const FR_EUR = { locale: "fr-FR", currency: "EUR" };

  it("de-DE groups every amount from four digits up, with the symbol after a non-breaking space", () => {
    assert.equal(formatMoney(123456, DE_EUR), "1.234,56\u00a0€");
    assert.equal(formatMoney(-320, DE_EUR), "-3,20\u00a0€");
    assert.equal(formatMoney(-123456, DE_EUR), "-1.234,56\u00a0€");
    assert.equal(parseAmount("1.234,56", DE_EUR), 123456);
    assert.equal(parseAmount("1234,56", DE_EUR), 123456);
    assert.equal(parseAmount("-1.234,56", DE_EUR), -123456);
  });

  it("es-ES does not group a four-digit amount, and both forms parse", () => {
    assert.equal(formatMoney(123456, ES_EUR), "1234,56\u00a0€");
    assert.equal(formatMoney(1234567, ES_EUR), "12.345,67\u00a0€");
    assert.equal(formatMoney(-123456, ES_EUR), "-1234,56\u00a0€");
    assert.equal(parseAmount("1234,56", ES_EUR), 123456);
    assert.equal(parseAmount("1.234,56", ES_EUR), 123456);
    assert.equal(parseAmount("12.345,67", ES_EUR), 1234567);
  });

  it("fr-FR puts the minus first and the symbol last, and groups with a narrow non-breaking space", () => {
    assert.equal(formatMoney(123456, FR_EUR), "1\u202f234,56\u00a0€");
    assert.equal(formatMoney(-320, FR_EUR), "-3,20\u00a0€");
    assert.equal(formatMoney(-123456, FR_EUR), "-1\u202f234,56\u00a0€");
    assert.equal(parseAmount("-1\u202f234,56", FR_EUR), -123456);
    assert.equal(parseAmount("-1 234,56", FR_EUR), -123456);
    assert.equal(parseAmount("-3,20", FR_EUR), -320);
  });
});

describe("currencyDecimals", () => {
  it("knows how many decimals each currency has", () => {
    assert.equal(currencyDecimals("EUR"), 2);
    assert.equal(currencyDecimals("JPY"), 0);
    assert.equal(currencyDecimals("KWD"), 3);
  });

  it("falls back to 2 for a code Intl cannot read, and formatMoney shows the amount with that code instead of throwing (#652)", () => {
    assert.equal(currencyDecimals("EURO"), 2);
    assert.equal(formatMoney(-123456, { locale: "en-US", currency: "EURO" }), "-1,234.56 EURO");
  });

  it("still throws for a missing or empty currency: only a non-empty stored code falls back", () => {
    for (const currency of [undefined, ""]) {
      assert.throws(() => currencyDecimals(currency as unknown as string));
      assert.throws(() => formatMoney(100, { locale: "en-US", currency: currency as unknown as string }));
    }
  });
});

describe("isKnownCurrency and assertKnownCurrency", () => {
  it("accept upper-case ISO 4217 codes in use", () => {
    for (const currency of ["EUR", "USD", "JPY", "KWD", "VES"]) {
      assert.equal(isKnownCurrency(currency), true, currency);
      assert.doesNotThrow(() => assertKnownCurrency(currency));
    }
  });

  it("refuse lower case, wrong lengths, unknown and withdrawn codes, and non-strings (#652)", () => {
    for (const currency of ["eur", "Eur", "EURO", "EU", "", " EUR", "XYZ", "VEF", undefined, null, 978]) {
      assert.equal(isKnownCurrency(currency), false, String(currency));
      assert.throws(
        () => assertKnownCurrency(currency),
        (error) => isValidationError(error, "invalid_currency") && error.details["currency"] === String(currency),
      );
    }
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
