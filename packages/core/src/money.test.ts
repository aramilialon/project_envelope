import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import {
  assertAmount,
  assertCents,
  assertKnownCurrency,
  assertTotal,
  currencyDecimals,
  formatMoney,
  isKnownCurrency,
  MAX_AMOUNT_CENTS,
  parseAmount,
  parseBalance,
  sumCents,
} from "./money.ts";

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

describe("the cap on a single amount (#651, ADR 0002)", () => {
  const tooLarge = (max: number) => (error: unknown) =>
    isValidationError(error, "amount_too_large") && error.details.max === max && error.details.label === "amount";

  // Every figure below is derived from the constant, so that changing the cap changes the tests
  // with it; only this first test pins its value.
  const typed = (minorUnits: number, locale: string, decimals = 2): string =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(minorUnits / 10 ** decimals);
  const plain = (minorUnits: number, decimals = 2): string => (minorUnits / 10 ** decimals).toFixed(decimals);

  it("is 10^12 minor units: €10,000,000,000.00", () => {
    assert.equal(MAX_AMOUNT_CENTS, 1_000_000_000_000);
    assert.equal(formatMoney(MAX_AMOUNT_CENTS, US_USD), "$10,000,000,000.00");
  });

  it("assertAmount accepts the cap either way and refuses one minor unit more, naming the cap", () => {
    assert.doesNotThrow(() => assertAmount(MAX_AMOUNT_CENTS));
    assert.doesNotThrow(() => assertAmount(-MAX_AMOUNT_CENTS));
    assert.throws(() => assertAmount(MAX_AMOUNT_CENTS + 1), tooLarge(MAX_AMOUNT_CENTS));
    assert.throws(() => assertAmount(-MAX_AMOUNT_CENTS - 1), tooLarge(MAX_AMOUNT_CENTS));
    assert.throws(() => assertAmount(Number.MAX_SAFE_INTEGER + 1), tooLarge(MAX_AMOUNT_CENTS));
    assert.throws(() => assertAmount(1.5), (error) => isValidationError(error, "invalid_amount"));
  });

  it("parseAmount accepts the cap and refuses one cent more, in either sign", () => {
    assert.equal(parseAmount(typed(MAX_AMOUNT_CENTS, "it-IT"), IT_EUR), MAX_AMOUNT_CENTS);
    assert.equal(parseAmount(`-${typed(MAX_AMOUNT_CENTS, "en-US")}`, US_USD), -MAX_AMOUNT_CENTS);
    assert.throws(() => parseAmount(typed(MAX_AMOUNT_CENTS + 1, "it-IT"), IT_EUR), tooLarge(MAX_AMOUNT_CENTS));
    assert.throws(() => parseAmount(`-${plain(MAX_AMOUNT_CENTS + 1)}`, US_USD), tooLarge(MAX_AMOUNT_CENTS));
  });

  it("parseAmount answers amount_too_large, not invalid_amount, for more digits than can be exact", () => {
    assert.throws(() => parseAmount("90071992547409930", US_USD), tooLarge(MAX_AMOUNT_CENTS));
  });

  it("parseBalance reads a balance above the cap, and refuses only what cannot be exact", () => {
    const balance = (MAX_AMOUNT_CENTS / 10) * 12;
    assert.equal(parseBalance(typed(balance, "it-IT"), IT_EUR), balance);
    assert.equal(parseBalance(`-${typed(balance, "en-US")}`, US_USD), -balance);
    assert.equal(parseBalance("-0,00", IT_EUR), 0);
    assert.throws(() => parseBalance("90071992547409930", US_USD), (error) => isValidationError(error, "invalid_amount"));
    assert.throws(() => parseBalance("12.345", US_USD), (error) => isValidationError(error, "invalid_amount_format"));
  });

  it("counts minor units whatever the currency: the cap in yen, with no decimals, and in dinars, with three", () => {
    const JPY = { locale: "en-US", currency: "JPY" };
    const KWD = { locale: "en-US", currency: "KWD" };
    assert.equal(parseAmount(typed(MAX_AMOUNT_CENTS, "en-US", 0), JPY), MAX_AMOUNT_CENTS);
    assert.throws(() => parseAmount(typed(MAX_AMOUNT_CENTS + 1, "en-US", 0), JPY), tooLarge(MAX_AMOUNT_CENTS));
    assert.equal(parseAmount(typed(MAX_AMOUNT_CENTS, "en-US", 3), KWD), MAX_AMOUNT_CENTS);
    assert.throws(() => parseAmount(typed(MAX_AMOUNT_CENTS + 1, "en-US", 3), KWD), tooLarge(MAX_AMOUNT_CENTS));
  });

  it("leaves sums alone: a total above the cap is still a valid total", () => {
    assert.equal(sumCents([MAX_AMOUNT_CENTS, MAX_AMOUNT_CENTS]), 2 * MAX_AMOUNT_CENTS);
  });

  it("a total beyond the safe range is amount_total_overflow, with the caller's details", () => {
    assert.throws(
      () => sumCents([Number.MAX_SAFE_INTEGER, 1]),
      (error) => isValidationError(error, "amount_total_overflow") && error.details.label === "total",
    );
    assert.throws(
      () => assertTotal(Number.MAX_SAFE_INTEGER + 1, "income", { month: "2026-11" }),
      (error) => isValidationError(error, "amount_total_overflow") && error.details.month === "2026-11" && error.details.label === "income",
    );
  });
});
