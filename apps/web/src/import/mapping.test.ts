import { describe, expect, it } from "vitest";

import { buildCsvMapping, guessColumnRoles, mappingProblems, rolesFromMapping, splitCsvPreview, type ColumnRole } from "./mapping.ts";

describe("splitCsvPreview", () => {
  it("splits each non-blank line into its own fields", () => {
    const rows = splitCsvPreview("Date,Description,Amount\n2026-09-01,Supermarket,-42.50\n");
    expect(rows).toEqual([
      ["Date", "Description", "Amount"],
      ["2026-09-01", "Supermarket", "-42.50"],
    ]);
  });

  it("honors a quoted field with an embedded comma, the same way the real import does", () => {
    const rows = splitCsvPreview('Date,Description,Amount\n2026-09-01,"Supermarket, downtown",-42.50\n');
    expect(rows[1]).toEqual(["2026-09-01", "Supermarket, downtown", "-42.50"]);
  });

  it("drops blank lines", () => {
    const rows = splitCsvPreview("Date,Description,Amount\n\n2026-09-01,Supermarket,-42.50\n\n");
    expect(rows).toHaveLength(2);
  });
});

describe("guessColumnRoles", () => {
  it("recognizes common English header names", () => {
    expect(guessColumnRoles(["Date", "Description", "Amount"])).toEqual(["date", "desc", "amount"]);
    expect(guessColumnRoles(["Booking date", "Narrative", "Debit", "Credit"])).toEqual(["date", "desc", "out", "in"]);
  });

  it("never assigns the same role twice", () => {
    const roles = guessColumnRoles(["Date", "Date", "Description"]);
    expect(roles.filter((r) => r === "date")).toHaveLength(1);
  });

  it("leaves an unrecognized column alone", () => {
    expect(guessColumnRoles(["Reference number"])).toEqual([""]);
  });
});

describe("mappingProblems", () => {
  it("passes a complete mapping with one amount column", () => {
    expect(mappingProblems(["date", "desc", "amount"])).toEqual([]);
  });

  it("passes a complete mapping with a separate outflow/inflow pair", () => {
    expect(mappingProblems(["date", "desc", "out", "in"])).toEqual([]);
  });

  it("flags a missing date, description and amount", () => {
    const roles: ColumnRole[] = ["", "", ""];
    expect(mappingProblems(roles)).toEqual(["missing_date", "missing_description", "missing_amount"]);
  });

  it("does not accept only one of outflow/inflow as a complete amount", () => {
    expect(mappingProblems(["date", "desc", "out"])).toEqual(["missing_amount"]);
  });
});

describe("buildCsvMapping", () => {
  const options = { hasHeaderRow: true, dateFormat: "YYYY-MM-DD" as const, decimalSeparator: "." as const };

  it("builds an amount-column mapping", () => {
    expect(buildCsvMapping(["date", "desc", "amount"], options)).toEqual({
      hasHeaderRow: true,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      decimalSeparator: ".",
      amountColumn: 2,
    });
  });

  it("builds an outflow/inflow mapping", () => {
    expect(buildCsvMapping(["date", "desc", "out", "in"], options)).toEqual({
      hasHeaderRow: true,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      decimalSeparator: ".",
      outflowColumn: 2,
      inflowColumn: 3,
    });
  });

  it("includes memoColumn only when one is assigned", () => {
    const mapping = buildCsvMapping(["date", "desc", "amount", "memo"], options);
    expect(mapping).toMatchObject({ memoColumn: 3 });
    expect(buildCsvMapping(["date", "desc", "amount"], options)).not.toHaveProperty("memoColumn");
  });

  it("returns undefined for an incomplete mapping", () => {
    expect(buildCsvMapping(["desc", "amount"], options)).toBeUndefined();
  });
});

describe("rolesFromMapping", () => {
  const options = { hasHeaderRow: true, dateFormat: "YYYY-MM-DD" as const, decimalSeparator: "." as const };

  it("is the inverse of buildCsvMapping for an amount-column mapping", () => {
    const roles: ColumnRole[] = ["date", "desc", "amount", "memo"];
    const mapping = buildCsvMapping(roles, options)!;
    expect(rolesFromMapping(mapping, 4)).toEqual(roles);
  });

  it("is the inverse of buildCsvMapping for an outflow/inflow mapping", () => {
    const roles: ColumnRole[] = ["date", "desc", "out", "in"];
    const mapping = buildCsvMapping(roles, options)!;
    expect(rolesFromMapping(mapping, 4)).toEqual(roles);
  });
});
