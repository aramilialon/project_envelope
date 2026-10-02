import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeTimeline, type TimelineEvent } from "./timeline.ts";

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return { day: 15, amountCents: 10_000, direction: "out", status: "recorded", payee: "Supermarket", ...overrides };
}

describe("computeTimeline", () => {
  it("places a day on the x axis proportionally across the month", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ day: 1 }), event({ day: 30 })] });
    const first = layout.marks.find((m) => m.day === 1)!;
    const last = layout.marks.find((m) => m.day === 30)!;
    assert.equal(first.x, layout.axisX0);
    assert.equal(last.x, layout.axisX1);
  });

  it("an outflow hangs below the axis, an inflow rises above it", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 10, direction: "out" }), event({ day: 20, direction: "in" })],
    });
    const out = layout.marks.find((m) => m.direction === "out")!;
    const inflow = layout.marks.find((m) => m.direction === "in")!;
    assert.ok(out.stemY > layout.axisY);
    assert.ok(inflow.stemY < layout.axisY);
  });

  it("a mark's length grows with the square root of the amount, never past the maximum", () => {
    const small = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ amountCents: 1_000 })] }).marks[0]!;
    const big = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ amountCents: 90_000 })] }).marks[0]!;
    const huge = computeTimeline({ daysInMonth: 30, today: undefined, events: [event({ amountCents: 50_000_000 })] }).marks[0]!;
    const smallLength = small.stemY - 100;
    const bigLength = big.stemY - 100;
    const hugeLength = huge.stemY - 100;
    assert.ok(smallLength > 0 && smallLength < bigLength);
    assert.ok(bigLength < hugeLength);
    // Doubling the amount nine times over (90,000 -> 50,000,000) grows the length far less than
    // ninefold — the whole point of the square root (design.md).
    assert.ok(hugeLength / bigLength < 9);
    assert.ok(hugeLength <= 72); // FULL's own maxLength
  });

  it("events on the same day, direction and status net into one mark", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 5, amountCents: 1_000, payee: "A" }), event({ day: 5, amountCents: 2_000, payee: "B" })],
    });
    assert.equal(layout.marks.length, 1);
    assert.equal(layout.marks[0]!.amountCents, 3_000);
    assert.deepEqual(layout.marks[0]!.label?.payees, ["A", "B"]);
  });

  it("events on the same day but a different status stay on separate marks", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 5, status: "recorded" }), event({ day: 5, status: "scheduled" })],
    });
    assert.equal(layout.marks.length, 2);
  });

  it("labels the largest recorded outflows, but not an ordinary smaller one", () => {
    const events = [1, 2, 3, 4, 5].map((day) => event({ day, amountCents: day * 10_000 }));
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events });
    const labelled = layout.marks.filter((m) => m.label !== undefined).map((m) => m.day);
    assert.deepEqual(labelled.sort((a, b) => a - b), [2, 3, 4, 5]); // the four largest, not day 1's smallest
  });

  it("every inflow and every scheduled or overdue item is labelled, regardless of size", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [
        event({ day: 1, amountCents: 100, direction: "in" }),
        event({ day: 2, amountCents: 100, status: "scheduled" }),
        event({ day: 3, amountCents: 100, status: "overdue" }),
      ],
    });
    assert.ok(layout.marks.every((m) => m.label !== undefined));
  });

  it("marks the 'today' line and the lighter ground past it only for the current month", () => {
    const current = computeTimeline({ daysInMonth: 30, today: 12, events: [] });
    assert.ok(current.todayX !== undefined);
    const other = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    assert.equal(other.todayX, undefined);
  });

  it("a past event's label never crosses the 'today' line", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 15,
      events: [event({ day: 14, amountCents: 1, direction: "in" })], // a tiny inflow, always labelled
    });
    const mark = layout.marks[0]!;
    assert.ok(mark.label!.x + 40 < layout.todayX!); // well short of the line, not just barely
  });

  it("two labels close enough to collide step apart instead of overlapping", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 10, direction: "in", amountCents: 1 }), event({ day: 11, direction: "in", amountCents: 1 })],
    });
    const labels = layout.marks.map((m) => m.label!);
    assert.notEqual(labels[0]!.y, labels[1]!.y);
  });

  it("day ticks span the month and always include its own last day", () => {
    const layout = computeTimeline({ daysInMonth: 31, today: undefined, events: [] });
    assert.equal(layout.dayTicks[0]!.day, 1);
    assert.equal(layout.dayTicks[layout.dayTicks.length - 1]!.day, 31);
  });

  it("a shorter month (28 days) still lays out cleanly, last day included", () => {
    const layout = computeTimeline({ daysInMonth: 28, today: undefined, events: [event({ day: 28 })] });
    assert.equal(layout.dayTicks[layout.dayTicks.length - 1]!.day, 28);
    assert.equal(layout.marks[0]!.x, layout.axisX1);
  });

  it("compact mode uses a smaller canvas and labels only inflows", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [event({ day: 10, direction: "out", amountCents: 999_999 }), event({ day: 11, direction: "in" })],
      compact: true,
    });
    assert.equal(layout.width, 330);
    const out = layout.marks.find((m) => m.direction === "out")!;
    const inflow = layout.marks.find((m) => m.direction === "in")!;
    assert.equal(out.label, undefined);
    assert.notEqual(inflow.label, undefined);
  });
});
