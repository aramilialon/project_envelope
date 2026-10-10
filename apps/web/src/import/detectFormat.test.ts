import { describe, expect, it } from "vitest";

import { detectImportFormat } from "./detectFormat.ts";

describe("detectImportFormat", () => {
  it("recognizes OFX, QIF and CAMT.053 (XML) by extension", () => {
    expect(detectImportFormat("statement.ofx")).toBe("ofx");
    expect(detectImportFormat("statement.qif")).toBe("qif");
    expect(detectImportFormat("statement.xml")).toBe("camt053");
  });

  it("is case-insensitive", () => {
    expect(detectImportFormat("STATEMENT.OFX")).toBe("ofx");
  });

  it("falls back to CSV for anything else, including .csv and .txt", () => {
    expect(detectImportFormat("statement.csv")).toBe("csv");
    expect(detectImportFormat("statement.txt")).toBe("csv");
    expect(detectImportFormat("statement")).toBe("csv");
  });
});
