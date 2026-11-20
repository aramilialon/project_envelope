import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import {
  assertIsin,
  INSTRUMENT_TYPES,
  isinCheckDigit,
  isValidIsin,
  normalizeInstrument,
  parseInstrumentSearch,
} from "./instrument.ts";
import { PRICE_FACTOR_HUNDREDTH, PRICE_FACTOR_ONE } from "./quantity.ts";

// Published ISINs, used here only as check-digit test vectors.
const VALID_ISINS = ["US0378331005", "AU0000XVGZA3", "GB0002634946", "IE00B4L5Y983", "DE0005140008"];

describe("isinCheckDigit", () => {
  it("computes the check digit of known ISINs", () => {
    for (const isin of VALID_ISINS) {
      assert.equal(isinCheckDigit(isin.slice(0, 11)), Number(isin[11]), isin);
    }
  });
});

describe("isValidIsin", () => {
  it("accepts well-formed ISINs with a correct check digit", () => {
    for (const isin of VALID_ISINS) {
      assert.equal(isValidIsin(isin), true, isin);
    }
  });

  it("rejects a wrong check digit", () => {
    assert.equal(isValidIsin("US0378331004"), false);
    assert.equal(isValidIsin("IE00B4L5Y984"), false);
  });

  it("rejects a transposition of two adjacent characters", () => {
    assert.equal(isValidIsin("US0373831005"), false);
  });

  it("rejects the wrong shape", () => {
    assert.equal(isValidIsin(""), false);
    assert.equal(isValidIsin("US037833100"), false); // 11 characters
    assert.equal(isValidIsin("US03783310055"), false); // 13 characters
    assert.equal(isValidIsin("1S0378331005"), false); // country code must be letters
    assert.equal(isValidIsin("US037833100A"), false); // check digit must be a digit
    assert.equal(isValidIsin("us0378331005"), false); // normalize case first
    assert.equal(isValidIsin("US-378331005"), false);
  });
});

describe("assertIsin", () => {
  it("throws invalid_isin with the value in details", () => {
    assert.throws(
      () => assertIsin("US0378331004"),
      (error) => isValidationError(error, "invalid_isin") && error.details.isin === "US0378331004",
    );
    assert.doesNotThrow(() => assertIsin("US0378331005"));
  });
});

describe("INSTRUMENT_TYPES", () => {
  it("is exactly the tax-relevant list, ETFs filed as funds", () => {
    assert.deepEqual([...INSTRUMENT_TYPES], ["stock", "fund", "etc_etn", "government_bond", "bond", "certificate", "cash", "other"]);
  });
});

describe("normalizeInstrument", () => {
  it("trims, upper-cases the ISIN, ticker, exchange and currency, and nulls empty optional fields", () => {
    assert.deepEqual(
      normalizeInstrument({
        isin: " ie00b4l5y983 ",
        ticker: " swda ",
        exchange: " xmil ",
        name: "  World equity ETF ",
        type: "fund",
        currency: "eur",
        assetClass: "  ",
      }),
      {
        isin: "IE00B4L5Y983",
        ticker: "SWDA",
        exchange: "XMIL",
        name: "World equity ETF",
        type: "fund",
        currency: "EUR",
        assetClass: null,
        priceFactorE6: 1_000_000,
      },
    );
  });

  it("accepts an ISIN alone, or a ticker on an exchange alone", () => {
    const byIsin = normalizeInstrument({ isin: "US0378331005", name: "A", type: "stock", currency: "USD" });
    assert.equal(byIsin.ticker, null);
    assert.equal(byIsin.exchange, null);
    const byTicker = normalizeInstrument({ ticker: "abc", exchange: "xnas", name: "A", type: "stock", currency: "USD" });
    assert.equal(byTicker.isin, null);
    assert.equal(byTicker.ticker, "ABC");
  });

  it("keeps a bond's price factor, and defaults to a factor of 1", () => {
    const bond = normalizeInstrument({
      isin: "US0378331005",
      name: "Bond",
      type: "government_bond",
      currency: "EUR",
      priceFactorE6: PRICE_FACTOR_HUNDREDTH,
    });
    assert.equal(bond.priceFactorE6, PRICE_FACTOR_HUNDREDTH);
    const stock = normalizeInstrument({ isin: "US0378331005", name: "A", type: "stock", currency: "USD", priceFactorE6: null });
    assert.equal(stock.priceFactorE6, PRICE_FACTOR_ONE);
  });

  it("strips control and format characters from the name and asset class", () => {
    const instrument = normalizeInstrument({
      isin: "US0378331005",
      name: "Wor\u200bld\u0007 equity\u202e",
      type: "fund",
      currency: "EUR",
      assetClass: "\u200b\u200b",
    });
    assert.equal(instrument.name, "World equity");
    assert.equal(instrument.assetClass, null);
    assert.throws(
      () => normalizeInstrument({ isin: "US0378331005", name: "\u200b\u0000 ", type: "fund", currency: "EUR" }),
      (error) => isValidationError(error, "invalid_instrument_field") && error.details.field === "name",
    );
  });

  it("accepts tickers with dots and hyphens and a four-character MIC", () => {
    const instrument = normalizeInstrument({ ticker: "brk.b", exchange: "xnys", name: "A", type: "stock", currency: "USD" });
    assert.equal(instrument.ticker, "BRK.B");
    assert.equal(instrument.exchange, "XNYS");
    assert.equal(normalizeInstrument({ ticker: "AB-C1", exchange: "X2X3", name: "A", type: "stock", currency: "USD" }).ticker, "AB-C1");
  });

  it("checks a ticker's length after upper-casing, which can lengthen it", () => {
    // "ß".toUpperCase() is "SS": 20 characters become 40.
    assert.throws(
      () => normalizeInstrument({ ticker: "\u00df".repeat(20), exchange: "XMIL", name: "A", type: "stock", currency: "EUR" }),
      (error) => isValidationError(error, "invalid_ticker"),
    );
    assert.equal(
      normalizeInstrument({ ticker: "\u00df".repeat(16), exchange: "XMIL", name: "A", type: "stock", currency: "EUR" }).ticker,
      "SS".repeat(16),
    );
  });

  it("rejects invalid input with stable codes", () => {
    const base = { isin: "US0378331005", name: "X", type: "stock", currency: "USD" };
    const cases: [Parameters<typeof normalizeInstrument>[0], string][] = [
      [{ ...base, name: "  " }, "invalid_instrument_field"],
      [{ ...base, name: "x".repeat(201) }, "invalid_instrument_field"],
      [{ ...base, assetClass: "x".repeat(65) }, "invalid_instrument_field"],
      [{ ...base, ticker: "X".repeat(33), exchange: "XMIL" }, "invalid_ticker"],
      [{ ...base, ticker: "AB C", exchange: "XMIL" }, "invalid_ticker"],
      [{ ...base, ticker: "AB/C", exchange: "XMIL" }, "invalid_ticker"],
      [{ ...base, ticker: "\u0410BC", exchange: "XMIL" }, "invalid_ticker"], // Cyrillic A
      [{ ...base, exchange: "MIL" }, "invalid_exchange"],
      [{ ...base, exchange: "XMILA" }, "invalid_exchange"],
      [{ ...base, exchange: "Borsa Italiana" }, "invalid_exchange"],
      [{ ...base, exchange: "XM\u0399L" }, "invalid_exchange"], // Greek capital iota
      [{ ...base, isin: "US0378331004" }, "invalid_isin"],
      [{ ...base, type: "crypto" }, "invalid_instrument_type"],
      [{ ...base, type: "etf" }, "invalid_instrument_type"], // an ETF is a `fund`
      [{ ...base, currency: "EURO" }, "invalid_currency"],
      [{ ...base, currency: "E1R" }, "invalid_currency"],
      [{ ...base, priceFactorE6: 0 }, "invalid_price_factor"],
      [{ ...base, priceFactorE6: -10_000 }, "invalid_price_factor"],
      [{ ...base, priceFactorE6: 0.01 }, "invalid_price_factor"],
      [{ name: "Cash", type: "cash", currency: "EUR" }, "missing_instrument_identifier"],
      [{ name: "Cash", type: "cash", currency: "EUR", isin: " ", exchange: "XMIL" }, "missing_instrument_identifier"],
      [{ name: "X", type: "stock", currency: "USD", ticker: "ABC" }, "missing_exchange"],
      [{ ...base, ticker: "ABC" }, "missing_exchange"],
    ];
    for (const [input, code] of cases) {
      assert.throws(() => normalizeInstrument(input), (error) => isValidationError(error, code as never), JSON.stringify(input));
    }
  });

  it("rejects a price factor that is not a number, with the same details shape as assertPriceFactor", () => {
    for (const priceFactorE6 of ["10000", true, {}]) {
      assert.throws(
        () => normalizeInstrument({ isin: "US0378331005", name: "X", type: "stock", currency: "USD", priceFactorE6 }),
        (error) =>
          isValidationError(error, "invalid_price_factor") &&
          error.details.label === "priceFactorE6" &&
          error.details.value === String(priceFactorE6),
      );
    }
    assert.throws(
      () => normalizeInstrument({ isin: "US0378331005", name: "X", type: "stock", currency: "USD", priceFactorE6: -1 }),
      (error) => isValidationError(error, "invalid_price_factor") && error.details.label === "priceFactorE6" && error.details.value === "-1",
    );
  });
});

describe("parseInstrumentSearch", () => {
  it("looks for an exact ISIN when the query is a valid one, in any case", () => {
    assert.deepEqual(parseInstrumentSearch(" ie00b4l5y983 "), { kind: "isin", isin: "IE00B4L5Y983" });
  });

  it("otherwise looks for a ticker or name prefix of at least 2 characters", () => {
    assert.deepEqual(parseInstrumentSearch(" ab "), { kind: "prefix", prefix: "ab" });
    // An ISIN-shaped query with a wrong check digit is still a usable prefix.
    assert.deepEqual(parseInstrumentSearch("US0378331004"), { kind: "prefix", prefix: "US0378331004" });
  });

  it("refuses an empty or one-character query, so the whole catalog can never be listed", () => {
    for (const query of ["", "   ", "a", " a "]) {
      assert.throws(
        () => parseInstrumentSearch(query),
        (error) => isValidationError(error, "search_query_too_short") && error.details.minLength === 2,
        JSON.stringify(query),
      );
    }
  });
});
