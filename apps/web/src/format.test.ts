import { describe, expect, it } from "vitest";

import { shortDate } from "./format.ts";

describe("shortDate", () => {
  it("leaves the year out for a date in the current year", () => {
    expect(shortDate("2026-10-09", "en-GB", 2026)).toBe("9 Oct");
  });

  it("shows the year for a date in a later year", () => {
    expect(shortDate("2028-03-03", "en-GB", 2026)).toBe("3 Mar 2028");
  });

  it("shows the year for a date in an earlier year", () => {
    expect(shortDate("2025-12-31", "en-GB", 2026)).toBe("31 Dec 2025");
  });

  it("follows the locale's own order and month names", () => {
    expect(shortDate("2028-03-03", "it-IT", 2026)).toBe("3 mar 2028");
  });

  it("compares with the browser's current year by default", () => {
    const year = new Date().getFullYear();
    expect(shortDate(`${year}-01-15`, "en-GB")).toBe("15 Jan");
    expect(shortDate(`${year + 1}-01-15`, "en-GB")).toBe(`15 Jan ${year + 1}`);
  });
});
