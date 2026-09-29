import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import { assertDate, assertMonth, compareMonths, monthOf, monthRange, nextMonth, previousMonth } from "./month.ts";

describe("months", () => {
  it("compute the next month, across the end of the year", () => {
    assert.equal(nextMonth("2026-09"), "2026-10");
    assert.equal(nextMonth("2026-12"), "2027-01");
  });

  it("compute the previous month, across the start of the year", () => {
    assert.equal(previousMonth("2026-09"), "2026-08");
    assert.equal(previousMonth("2027-01"), "2026-12");
  });

  it("compare in chronological order", () => {
    assert.ok(compareMonths("2026-09", "2026-10") < 0);
    assert.ok(compareMonths("2027-01", "2026-12") > 0);
    assert.equal(compareMonths("2026-09", "2026-09"), 0);
  });

  it("produce ranges with both ends included", () => {
    assert.deepEqual(monthRange("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
    assert.deepEqual(monthRange("2026-09", "2026-09"), ["2026-09"]);
    assert.deepEqual(monthRange("2026-10", "2026-09"), []);
  });

  it("reject invalid formats", () => {
    for (const text of ["2026-13", "2026-00", "2026-9", "26-09", "2026/09", ""]) {
      assert.throws(
        () => assertMonth(text),
        (error) => isValidationError(error, "invalid_month"),
        `"${text}" should have been rejected`,
      );
    }
  });

  it("derive the budget month of a date", () => {
    assert.equal(monthOf("2026-09-25"), "2026-09");
    assert.equal(monthOf("2028-02-29"), "2028-02"); // leap year
  });

  it("reject dates that do not exist", () => {
    for (const text of ["2026-02-29", "2026-13-01", "2026-04-31", "2026-9-1", "26-09-01", ""]) {
      assert.throws(
        () => assertDate(text),
        (error) => isValidationError(error, "invalid_date"),
        `"${text}" should have been rejected`,
      );
    }
  });
});
