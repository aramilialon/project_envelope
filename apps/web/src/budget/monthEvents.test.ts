import { describe, expect, it } from "vitest";

import type { MonthEvent } from "./api.ts";
import { toTimelineEvents } from "./monthEvents.ts";

function event(date: string, amountCents: number, kind: MonthEvent["kind"]): MonthEvent {
  return { date, amountCents, payee: null, categoryId: null, kind };
}

describe("toTimelineEvents", () => {
  const today = { iso: "2026-11-21" };

  it("keeps a recorded row up to today in the solid part, and draws one after today in the projected part (#702)", () => {
    const result = toTimelineEvents(
      [event("2026-11-10", 200_000, "recorded"), event("2026-11-21", -1_000, "pending"), event("2026-11-25", -4_000, "pending"), event("2026-11-28", 3_000, "recorded")],
      today,
    );
    expect(result.map((e) => e.status)).toEqual(["recorded", "recorded", "scheduled", "scheduled"]);
    expect(result[2]).toEqual({ day: 25, amountCents: 4_000, direction: "out", status: "scheduled" });
  });

  it("marks a scheduled item before today overdue, and one from today on scheduled", () => {
    const result = toTimelineEvents([event("2026-11-15", -4_500, "scheduled"), event("2026-11-21", -100, "scheduled"), event("2026-11-27", 245_000, "scheduled")], today);
    expect(result.map((e) => e.status)).toEqual(["overdue", "scheduled", "scheduled"]);
  });

  it("draws every recorded row solid in a month that is not the current one", () => {
    const result = toTimelineEvents([event("2026-11-28", 3_000, "recorded")], undefined);
    expect(result[0]!.status).toBe("recorded");
  });
});
