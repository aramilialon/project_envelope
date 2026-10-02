import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { daysIn, monthOffset, todayAt } from "./dates.ts";

const TIME_ZONE = "UTC";
const YEAR = 2026;
const MONTH = 10; // October, 31 days — long enough to exercise every branch below

function fixedToday(dayOfMonth: number) {
  // Noon UTC avoids any midnight/DST edge in Intl.DateTimeFormat's own day computation.
  return todayAt(new Date(Date.UTC(YEAR, MONTH - 1, dayOfMonth, 12)), TIME_ZONE);
}

const TODAY_STR = (day: number) => `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

describe("todayAt", () => {
  for (const day of [2, 15, 28]) {
    describe(`when today is day ${day} of the month`, () => {
      const today = fixedToday(day);
      const todayStr = TODAY_STR(day);

      it("reports the current month and today's own date", () => {
        assert.equal(today.month, `${YEAR}-${String(MONTH).padStart(2, "0")}`);
        assert.equal(today.isoDate(0), todayStr);
      });

      it("a pending transaction (today or yesterday) is never after today", () => {
        assert.ok(today.isoDate(0) <= todayStr);
        assert.ok(today.isoDate(-1) <= todayStr);
      });

      it("onOrBeforeToday never returns a date after today, for a day earlier, on, or later than today", () => {
        for (const fixedDay of [1, day, Math.min(28, day + 15)]) {
          assert.ok(today.onOrBeforeToday(fixedDay) <= todayStr, `onOrBeforeToday(${fixedDay}) must be <= ${todayStr}`);
        }
      });

      it("onOrBeforeToday returns the fixed day itself when it has already happened", () => {
        if (day > 1) {
          assert.equal(today.onOrBeforeToday(1), TODAY_STR(1));
        }
      });

      it("beforeTodaySameMonth is always strictly before today", () => {
        for (const daysBack of [1, 5, 10]) {
          assert.ok(today.beforeTodaySameMonth(daysBack) < todayStr, `beforeTodaySameMonth(${daysBack}) must be < ${todayStr}`);
        }
      });

      it("afterTodaySameMonth is always strictly after today", () => {
        for (const daysForward of [1, 5, 10]) {
          assert.ok(today.afterTodaySameMonth(daysForward) > todayStr, `afterTodaySameMonth(${daysForward}) must be > ${todayStr}`);
        }
      });
    });
  }

  it("beforeTodaySameMonth falls back to the previous month's last day when today is the 1st", () => {
    const today = fixedToday(1);
    const result = today.beforeTodaySameMonth(5);
    assert.ok(result < TODAY_STR(1));
    assert.equal(result, `${YEAR}-09-30`); // September has 30 days
  });

  it("afterTodaySameMonth falls forward to next month's first day when today is the month's last day", () => {
    const lastDay = daysIn(YEAR, MONTH);
    const today = fixedToday(lastDay);
    const result = today.afterTodaySameMonth(5);
    assert.ok(result > TODAY_STR(lastDay));
    assert.equal(result, `${YEAR}-11-01`);
  });
});

describe("monthOffset", () => {
  it("moves forward and backward within a year", () => {
    assert.equal(monthOffset("2026-06", 1), "2026-07");
    assert.equal(monthOffset("2026-06", -1), "2026-05");
  });

  it("carries across a year boundary in both directions", () => {
    assert.equal(monthOffset("2026-12", 1), "2027-01");
    assert.equal(monthOffset("2026-01", -1), "2025-12");
  });
});

describe("daysIn", () => {
  it("knows February in a leap year", () => {
    assert.equal(daysIn(2028, 2), 29);
  });

  it("knows February in a non-leap year", () => {
    assert.equal(daysIn(2026, 2), 28);
  });

  it("knows a 31-day month", () => {
    assert.equal(daysIn(2026, 10), 31);
  });
});
