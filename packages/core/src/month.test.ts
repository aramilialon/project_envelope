import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import { advanceDate, assertDate, assertMonth, compareMonths, monthOf, monthRange, shiftMonth, startOfLocalDay } from "./month.ts";

describe("months", () => {
  it("shifts forward, across the end of the year", () => {
    assert.equal(shiftMonth("2026-09", 1), "2026-10");
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
  });

  it("shifts backward, across the start of the year", () => {
    assert.equal(shiftMonth("2026-09", -1), "2026-08");
    assert.equal(shiftMonth("2027-01", -1), "2026-12");
  });

  it("shifts by more than one month, wrapping as many years as needed", () => {
    assert.equal(shiftMonth("2026-09", 5), "2027-02");
    assert.equal(shiftMonth("2026-09", -11), "2025-10");
  });

  it("returns the same month for a zero shift", () => {
    assert.equal(shiftMonth("2026-09", 0), "2026-09");
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

describe("startOfLocalDay", () => {
  it("is local midnight in Europe/Rome, in winter and in summer", () => {
    assert.equal(startOfLocalDay("2026-01-10", "Europe/Rome"), "2026-01-09T23:00:00.000Z");
    assert.equal(startOfLocalDay("2026-07-10", "Europe/Rome"), "2026-07-09T22:00:00.000Z");
  });

  it("follows the daylight saving change on the day it happens, which is after midnight in Europe/Rome", () => {
    // The clocks change at 02:00 or 03:00: midnight still has the offset of the day before.
    assert.equal(startOfLocalDay("2026-03-29", "Europe/Rome"), "2026-03-28T23:00:00.000Z");
    assert.equal(startOfLocalDay("2026-03-30", "Europe/Rome"), "2026-03-29T22:00:00.000Z");
    assert.equal(startOfLocalDay("2026-10-25", "Europe/Rome"), "2026-10-24T22:00:00.000Z");
    assert.equal(startOfLocalDay("2026-10-26", "Europe/Rome"), "2026-10-25T23:00:00.000Z");
  });

  it("is midnight UTC in UTC, and moves the right way far east and far west", () => {
    assert.equal(startOfLocalDay("2026-01-10", "UTC"), "2026-01-10T00:00:00.000Z");
    assert.equal(startOfLocalDay("2026-01-10", "Pacific/Kiritimati"), "2026-01-09T10:00:00.000Z");
    assert.equal(startOfLocalDay("2026-01-10", "Pacific/Pago_Pago"), "2026-01-10T11:00:00.000Z");
  });

  it("starts the day when the clocks jump where midnight does not exist, as PostgreSQL does", () => {
    // America/Santiago and America/Havana move from 00:00 straight to 01:00.
    assert.equal(startOfLocalDay("2026-09-06", "America/Santiago"), "2026-09-06T04:00:00.000Z");
    assert.equal(startOfLocalDay("2026-03-08", "America/Havana"), "2026-03-08T05:00:00.000Z");
    // Santiago going back at 24:00 to 23:00 of the day before: the new day starts an hour later.
    assert.equal(startOfLocalDay("2026-04-05", "America/Santiago"), "2026-04-05T04:00:00.000Z");
  });

  it("keeps an offset in seconds from before standard time", () => {
    assert.equal(startOfLocalDay("1890-01-01", "Europe/Rome"), "1889-12-31T23:10:04.000Z");
  });

  it("refuses a malformed date and an unknown time zone", () => {
    assert.throws(() => startOfLocalDay("2026-02-30", "Europe/Rome"), (error) => isValidationError(error, "invalid_date"));
    assert.throws(() => startOfLocalDay("2026-02-10", "Europe/Nowhere"), (error) => isValidationError(error, "invalid_time_zone"));
  });
});
