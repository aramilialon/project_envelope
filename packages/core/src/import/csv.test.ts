import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { parseCsv, type CsvMapping } from "./csv.ts";

describe("parseCsv", () => {
  it("parses a single amount column, ISO dates, a header row and a dot decimal separator", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: true,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    const content = "Date,Description,Amount\n2026-09-15,Grocery store,-42.50\n2026-09-16,Salary,1000.00\n";

    const rows = parseCsv(content, mapping);
    assert.deepEqual(rows, [
      { date: "2026-09-15", payee: "Grocery store", amountCents: -4250 },
      { date: "2026-09-16", payee: "Salary", amountCents: 100000 },
    ]);
  });

  it("parses separate outflow and inflow columns", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "DD/MM/YYYY",
      descriptionColumn: 1,
      outflowColumn: 2,
      inflowColumn: 3,
      decimalSeparator: ",",
    };
    // A comma decimal separator needs its amount field quoted, since the same
    // comma is also this CSV's own column delimiter.
    const content = '15/09/2026,Grocery store,"42,50",\n16/09/2026,Salary,,"1000,00"\n';

    const rows = parseCsv(content, mapping);
    assert.deepEqual(rows, [
      { date: "2026-09-15", payee: "Grocery store", amountCents: -4250 },
      { date: "2026-09-16", payee: "Salary", amountCents: 100000 },
    ]);
  });

  it("reads MM/DD/YYYY dates", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "MM/DD/YYYY",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    const rows = parseCsv("09/05/2026,Coffee,-3.50\n", mapping);
    assert.equal(rows[0]?.date, "2026-09-05");
  });

  it("keeps an optional memo column, and omits it when empty", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      memoColumn: 3,
      decimalSeparator: ".",
    };
    const rows = parseCsv("2026-09-15,Grocery store,-42.50,split with a friend\n2026-09-16,Salary,1000.00,\n", mapping);
    assert.equal(rows[0]?.memo, "split with a friend");
    assert.equal(rows[1]?.memo, undefined);
  });

  it("honors a quoted field with an embedded comma", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    const rows = parseCsv('2026-09-15,"Grocery store, downtown",-42.50\n', mapping);
    assert.equal(rows[0]?.payee, "Grocery store, downtown");
  });

  it("rejects a malformed date with a translatable error", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    assert.throws(
      () => parseCsv("not-a-date,Grocery store,-42.50\n", mapping),
      (error: unknown) => isValidationError(error, "invalid_date"),
    );
  });

  it("rejects a malformed amount with a translatable error", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    assert.throws(
      () => parseCsv("2026-09-15,Grocery store,not-a-number\n", mapping),
      (error: unknown) => isValidationError(error, "invalid_amount_format"),
    );
  });

  it("skips blank lines", () => {
    const mapping: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    const rows = parseCsv("2026-09-15,Grocery store,-42.50\n\n2026-09-16,Salary,1000.00\n", mapping);
    assert.equal(rows.length, 2);
  });
});
