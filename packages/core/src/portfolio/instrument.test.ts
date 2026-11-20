import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import {
  assertIsin,
  assertPriceFactorE6,
  INSTRUMENT_TYPES,
  isinCheckDigit,
  isValidIsin,
  normalizeInstrument,
  parseInstrumentSearch,
} from "./instrument.ts";

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

describe("assertPriceFactorE6", () => {
  it("accepts a positive safe integer", () => {
    for (const value of [1_000_000, 10_000, 1]) {
      assert.doesNotThrow(() => assertPriceFactorE6(value), String(value));
    }
  });

  it("rejects zero, negatives, fractions, non-numbers and unsafe integers", () => {
    for (const value of [0, -1, -10_000, 0.5, 10_000.5, Number.NaN, Infinity, 2 ** 53, "10000", null, true]) {
      assert.throws(() => assertPriceFactorE6(value), (error) => isValidationError(error, "invalid_price_factor"), String(value));
    }
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

  it("keeps a bond's price factor", () => {
    const bond = normalizeInstrument({ isin: "US0378331005", name: "Bond", type: "government_bond", currency: "EUR", priceFactorE6: 10_000 });
    assert.equal(bond.priceFactorE6, 10_000);
  });

  it("rejects a missing name, an invalid ISIN, type, currency or price factor with stable codes", () => {
    const base = { isin: "US0378331005", name: "X", type: "stock", currency: "USD" };
    const cases: [Parameters<typeof normalizeInstrument>[0], string][] = [
      [{ ...base, name: "  " }, "invalid_instrument_field"],
      [{ ...base, name: "x".repeat(201) }, "invalid_instrument_field"],
      [{ ...base, ticker: "x".repeat(33) }, "invalid_instrument_field"],
      [{ ...base, isin: "US0378331004" }, "invalid_isin"],
      [{ ...base, type: "crypto" }, "invalid_instrument_type"],
      [{ ...base, type: "etf" }, "invalid_instrument_type"], // an ETF is a `fund`
      [{ ...base, currency: "EURO" }, "invalid_currency"],
      [{ ...base, currency: "E1R" }, "invalid_currency"],
      [{ ...base, priceFactorE6: 0 }, "invalid_price_factor"],
      [{ ...base, priceFactorE6: -10_000 }, "invalid_price_factor"],
      [{ ...base, priceFactorE6: 0.01 }, "invalid_price_factor"],
      [{ ...base, priceFactorE6: "10000" }, "invalid_price_factor"],
      [{ name: "Cash", type: "cash", currency: "EUR" }, "missing_instrument_identifier"],
      [{ name: "Cash", type: "cash", currency: "EUR", isin: " ", exchange: "XMIL" }, "missing_instrument_identifier"],
      [{ name: "X", type: "stock", currency: "USD", ticker: "ABC" }, "missing_exchange"],
      [{ ...base, ticker: "ABC" }, "missing_exchange"],
    ];
    for (const [input, code] of cases) {
      assert.throws(() => normalizeInstrument(input), (error) => isValidationError(error, code as never), JSON.stringify(input));
    }
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
