import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentMonthIn, todayIsoIn } from "./workspaceDate.ts";

describe("todayIsoIn / currentMonthIn (#326)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the date in the given time zone, not UTC", () => {
    // 23:30 UTC on the 2nd is already the 3rd in a time zone 14 hours ahead.
    vi.setSystemTime(new Date("2026-10-02T23:30:00.000Z"));
    expect(todayIsoIn("UTC")).toBe("2026-10-02");
    expect(todayIsoIn("Pacific/Kiritimati")).toBe("2026-10-03");
  });

  it("two workspaces in different time zones can disagree on today at the same instant", () => {
    // 01:30 UTC is already the 2nd in Rome (UTC+2 in October) but still the 1st in Los Angeles (UTC-7).
    vi.setSystemTime(new Date("2026-10-02T01:30:00.000Z"));
    expect(todayIsoIn("Europe/Rome")).toBe("2026-10-02");
    expect(todayIsoIn("America/Los_Angeles")).toBe("2026-10-01");
  });

  it("derives the current month from the same time-zoned date, even across a month boundary", () => {
    // 03:00 UTC on October 1st is still the last day of September, 7 hours behind, in Los Angeles.
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    expect(currentMonthIn("America/Los_Angeles")).toBe("2026-09");
    expect(currentMonthIn("Europe/Rome")).toBe("2026-10");
  });
});
