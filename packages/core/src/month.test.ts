import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import { advanceDate, assertDate, assertMonth, compareMonths, monthOf, monthRange, nextMonth, previousMonth } from "./month.ts";

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

describe("advanceDate", () => {
  it("advances by whole days, including across a month boundary", () => {
    assert.equal(advanceDate("2026-09-28", 5, "day"), "2026-10-03");
  });

  it("advances by months, keeping the same day of month", () => {
    assert.equal(advanceDate("2026-09-15", 2, "month"), "2026-11-15");
  });

  it("advances by months across a year boundary", () => {
    assert.equal(advanceDate("2026-11-15", 3, "month"), "2027-02-15");
  });

  it("clamps the day to the target month's own last day, never rolling over", () => {
    assert.equal(advanceDate("2026-01-31", 1, "month"), "2026-02-28");
    assert.equal(advanceDate("2028-01-31", 1, "month"), "2028-02-29"); // leap year
  });

  it("advances by years, keeping month and day", () => {
    assert.equal(advanceDate("2026-09-15", 1, "year"), "2027-09-15");
  });

  it("advances by years from a leap day, clamped to the target year's own last day of February", () => {
    assert.equal(advanceDate("2028-02-29", 1, "year"), "2029-02-28");
  });

  it("rejects a non-positive or non-integer recurrence", () => {
    for (const every of [0, -1, 1.5]) {
      assert.throws(
        () => advanceDate("2026-09-15", every, "month"),
        (error) => isValidationError(error, "invalid_recurrence"),
        `${every} should have been rejected`,
      );
    }
  });

  it("rejects an invalid date, the same as assertDate", () => {
    assert.throws(() => advanceDate("2026-02-30", 1, "month"), (error) => isValidationError(error, "invalid_date"));
  });
});
