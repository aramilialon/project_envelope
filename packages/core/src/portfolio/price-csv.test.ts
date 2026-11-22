import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { assertLocale, assertPriceDate, MAX_PRICE_CSV_ROWS, parsePriceCsv } from "./price-csv.ts";

const TODAY = "2026-04-01";

/** Asserts that `run` refuses the file with `invalid_price_file` at the given line, column and reason. */
function assertRefused(run: () => unknown, line: number, column: number, reason: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(isValidationError(error, "invalid_price_file"), `expected invalid_price_file, got ${String(error)}`);
    assert.deepEqual(error.details, { line, column, reason });
    return true;
  });
}

describe("assertPriceDate", () => {
  it("accepts today and earlier dates", () => {
    assertPriceDate("2026-04-01", TODAY);
    assertPriceDate("1900-01-01", TODAY);
  });

  it("refuses a date after today with the limit, and a malformed date as invalid_date", () => {
    assert.throws(
      () => assertPriceDate("2026-04-02", TODAY),
      (error: unknown) => isValidationError(error, "price_date_in_future") && error.details.max === TODAY,
    );
    assert.throws(() => assertPriceDate("2026-02-30", TODAY), (error: unknown) => isValidationError(error, "invalid_date"));
    assert.throws(() => assertPriceDate("01/04/2026", TODAY), (error: unknown) => isValidationError(error, "invalid_date"));
  });
});

describe("assertLocale", () => {
  it("accepts locale tags and refuses anything else", () => {
    assertLocale("it-IT");
    assertLocale("en");
    for (const value of ["", "  ", "not a locale", "it_IT!"]) {
      assert.throws(() => assertLocale(value), (error: unknown) => isValidationError(error, "invalid_locale") && error.details.value === value);
    }
  });
});

describe("parsePriceCsv", () => {
  it("reads a file with a header, in the file's order, prices scaled by 10^6", () => {
    const rows = parsePriceCsv("date,close\n2026-03-31,101.5\n2026-03-30,100\n", { locale: "en-US", today: TODAY });
    assert.deepEqual(rows, [
      { priceDate: "2026-03-31", closeE6: 101_500000 },
      { priceDate: "2026-03-30", closeE6: 100_000000 },
    ]);
  });

  it("reads a file without a header, with CRLF line ends, a byte order mark, blank lines and spaces", () => {
    const rows = parsePriceCsv("﻿ 2026-03-30 , 99.123456 \r\n\r\n2026-03-31,0\r\n", { locale: "en", today: TODAY });
    assert.deepEqual(rows, [
      { priceDate: "2026-03-30", closeE6: 99_123456 },
      { priceDate: "2026-03-31", closeE6: 0 },
    ]);
  });

  it("follows the locale: a quoted comma decimal and dot groups in Italian", () => {
    const rows = parsePriceCsv('DATE,Close\n2026-03-31,"1.234,56"\n2026-03-30,"87,123456"\n', { locale: "it-IT", today: TODAY });
    assert.deepEqual(rows, [
      { priceDate: "2026-03-31", closeE6: 1_234_560000 },
      { priceDate: "2026-03-30", closeE6: 87_123456 },
    ]);
  });

  it("accepts a price dated today, in the time zone the caller computed it in", () => {
    assert.deepEqual(parsePriceCsv("2026-04-01,10", { locale: "en", today: TODAY }), [{ priceDate: "2026-04-01", closeE6: 10_000000 }]);
  });

  it("refuses the whole file at the first bad line, naming the line (blank lines counted) and the column", () => {
    const options = { locale: "en", today: TODAY };
    assertRefused(() => parsePriceCsv("date,close\n2026-03-30,100\n\n2026-02-30,100\n2026-13-01,x", options), 4, 1, "invalid_date");
    assertRefused(() => parsePriceCsv("date,close\n2026-04-02,100", options), 2, 1, "price_date_in_future");
    assertRefused(() => parsePriceCsv("2026-03-30,100\n2026-03-30,101", options), 2, 1, "duplicate_date");
    assertRefused(() => parsePriceCsv("2026-03-30,abc", options), 1, 2, "invalid_price_format");
    assertRefused(() => parsePriceCsv("2026-03-30,1.1234567", options), 1, 2, "invalid_price_format");
    assertRefused(() => parsePriceCsv("2026-03-30,", options), 1, 2, "invalid_price_format");
    assertRefused(() => parsePriceCsv("2026-03-30,-1", options), 1, 2, "invalid_price");
    assertRefused(() => parsePriceCsv("2026-03-30,99999999999", options), 1, 2, "invalid_price");
    assertRefused(() => parsePriceCsv("2026-03-30", options), 1, 2, "missing_column");
    assertRefused(() => parsePriceCsv("2026-03-30,1,234.5", options), 1, 3, "extra_column");
    assertRefused(() => parsePriceCsv("2026-03-30,1.5,", options), 1, 3, "extra_column");
  });

  it("reads a comma as a group separator in English, and a dot as one in Italian, never as a decimal", () => {
    assert.deepEqual(parsePriceCsv('2026-03-30,"1,234.5"', { locale: "en", today: TODAY }), [{ priceDate: "2026-03-30", closeE6: 1_234_500000 }]);
    assertRefused(() => parsePriceCsv("2026-03-30,1.5", { locale: "it-IT", today: TODAY }), 1, 2, "invalid_price_format");
  });

  it("refuses a file with no price", () => {
    assertRefused(() => parsePriceCsv("", { locale: "en", today: TODAY }), 1, 1, "no_rows");
    assertRefused(() => parsePriceCsv("\n\n", { locale: "en", today: TODAY }), 1, 1, "no_rows");
    assertRefused(() => parsePriceCsv("date,close\n", { locale: "en", today: TODAY }), 1, 1, "no_rows");
  });

  it("accepts the maximum number of rows and refuses one more before reading any", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => {
        const date = new Date(Date.UTC(1950, 0, 1 + index)).toISOString().slice(0, 10);
        return `${date},1`;
      });
    assert.equal(parsePriceCsv(["date,close", ...lines(MAX_PRICE_CSV_ROWS)].join("\n"), { locale: "en", today: TODAY }).length, MAX_PRICE_CSV_ROWS);
    // One row over, and the extra row malformed: the count is refused first.
    const tooMany = ["date,close", ...lines(MAX_PRICE_CSV_ROWS), "garbage"].join("\n");
    assert.throws(
      () => parsePriceCsv(tooMany, { locale: "en", today: TODAY }),
      (error: unknown) => isValidationError(error, "too_many_rows") && error.details.max === MAX_PRICE_CSV_ROWS,
    );
  });

  it("refuses a locale that is not one", () => {
    assert.throws(() => parsePriceCsv("2026-03-30,1", { locale: "??", today: TODAY }), (error: unknown) => isValidationError(error, "invalid_locale"));
  });
});
