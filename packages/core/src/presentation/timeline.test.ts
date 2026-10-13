import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeTimeline, type TimelineEvent } from "./timeline.ts";

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return { day: 15, amountCents: 10_000, direction: "out", status: "recorded", ...overrides };
}

describe("computeTimeline", () => {
  it("starts at zero and accumulates each day's own net amount into the running total", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 10,
      events: [event({ day: 3, amountCents: 5_000, direction: "in" }), event({ day: 6, amountCents: 2_000, direction: "out" })],
    });
    assert.equal(layout.current!.amountCents, 3_000);
  });

  it("an inflow day colours its own segment 'in', an outflow day 'out'", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 5, direction: "in" }), event({ day: 10, direction: "out" })],
    });
    const risingSegment = layout.segments.find((s) => s.to.day === 5)!;
    const fallingSegment = layout.segments.find((s) => s.to.day === 10)!;
    assert.equal(risingSegment.direction, "in");
    assert.equal(fallingSegment.direction, "out");
  });

  it("a day with no event at all stays flat, carrying the previous level forward", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ day: 5 })] });
    const flat = layout.segments.find((s) => s.to.day === 6)!;
    assert.equal(flat.direction, "flat");
    assert.equal(flat.from.y, flat.to.y);
  });

  it("events on the same day net together before the segment is drawn", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 5, amountCents: 1_000, direction: "in" }), event({ day: 5, amountCents: 400, direction: "out" })],
    });
    const segment = layout.segments.find((s) => s.to.day === 5)!;
    assert.equal(segment.direction, "in"); // net +600 on day 5
  });

  it("only recorded events count toward the actual total through today", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 10,
      events: [event({ day: 5, amountCents: 1_000, direction: "in", status: "scheduled" })],
    });
    assert.equal(layout.current!.amountCents, 0); // the scheduled event does not count yet
  });

  it("an overdue item does not count as actually happened, but flags its own marker, folded into today's point rather than its own earlier day", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 10,
      events: [event({ day: 5, amountCents: 1_000, direction: "out", status: "overdue" })],
    });
    assert.equal(layout.current!.amountCents, 0); // not recorded yet — the real total is unchanged
    assert.equal(layout.current!.hasOverdue, true);
    assert.notEqual(layout.current!.overdueY, layout.current!.y); // the marker sits where the total would be if it had already happened
    // Folded in at today, not drawn as its own earlier-day segment: the actual line (days 1..10)
    // never moves on day 5 at all — flat, the same as a day with nothing on it.
    const day5 = layout.segments.find((s) => s.to.day === 5 && !s.projected)!;
    assert.equal(day5.direction, "flat");
  });

  it("has no overdue marker when every scheduled item is still ahead of today", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 10,
      events: [event({ day: 20, amountCents: 1_000, direction: "out", status: "scheduled" })],
    });
    assert.equal(layout.current!.hasOverdue, false);
    assert.equal(layout.current!.overdueY, undefined);
  });

  it("scheduled items project the line past today, dashed, and recorded ones do not reach that far", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 10,
      events: [event({ day: 20, amountCents: 1_000, direction: "in", status: "scheduled" })],
    });
    const projectedRise = layout.segments.find((s) => s.to.day === 20)!;
    assert.equal(projectedRise.projected, true);
    assert.equal(projectedRise.direction, "in");
    assert.ok(layout.segments.every((s) => s.to.day <= 10 || s.projected));
  });

  it("without 'today', nothing is projected: scheduled events fold straight into the one solid line", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 20, amountCents: 1_000, direction: "in", status: "scheduled" })],
    });
    assert.ok(layout.segments.every((s) => !s.projected));
    assert.equal(layout.current, undefined);
    const segment = layout.segments.find((s) => s.to.day === 20)!;
    assert.equal(segment.direction, "in");
  });

  it("marks the 'today' line only for the current month", () => {
    const current = computeTimeline({ daysInMonth: 30, today: 12, events: [] });
    assert.ok(current.todayX !== undefined);
    const other = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    assert.equal(other.todayX, undefined);
    assert.equal(other.current, undefined);
  });

  it("places day 1 and the month's own last day at the axis's own two ends", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ day: 1 }), event({ day: 30 })] });
    const first = layout.segments.find((s) => s.to.day === 2)!; // day 1 has no segment of its own (nothing before it)
    const last = layout.segments.find((s) => s.to.day === 30)!;
    assert.equal(first.from.x, layout.axisX0);
    assert.equal(last.to.x, layout.axisX1);
  });

  it("zero sits wherever it falls in the month's own value range, not always the canvas's own center", () => {
    const allNegative = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ day: 15, direction: "out" })] });
    const allPositive = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ day: 15, direction: "in" })] });
    // A month that only ever goes down keeps zero near the top of the plotted range; one that
    // only ever goes up keeps it near the bottom — opposite of each other.
    assert.ok(allNegative.zeroY < allPositive.zeroY);
  });

  it("a flat month (no events at all) still lays out without dividing by zero", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: 10, events: [] });
    assert.equal(layout.current!.amountCents, 0);
    assert.ok(Number.isFinite(layout.zeroY));
    assert.ok(layout.segments.every((s) => Number.isFinite(s.from.y) && Number.isFinite(s.to.y)));
  });

  it("day ticks span the month and always include its own last day", () => {
    const layout = computeTimeline({ daysInMonth: 31, today: undefined, events: [] });
    assert.equal(layout.dayTicks[0]!.day, 1);
    assert.equal(layout.dayTicks[layout.dayTicks.length - 1]!.day, 31);
  });

  it("a shorter month (28 days) still lays out cleanly, last day included", () => {
    const layout = computeTimeline({ daysInMonth: 28, today: undefined, events: [event({ day: 28 })] });
    assert.equal(layout.dayTicks[layout.dayTicks.length - 1]!.day, 28);
    const last = layout.segments.find((s) => s.to.day === 28)!;
    assert.equal(last.to.x, layout.axisX1);
  });

  it("compact mode uses a smaller canvas", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [], compact: true });
    assert.equal(layout.width, 330);
    assert.equal(layout.height, 120);
  });
});
