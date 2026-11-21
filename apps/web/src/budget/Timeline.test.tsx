import { computeTimeline, formatMoney } from "@envelope/core";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import { estimateTextWidth, timelineValueLabelWidth } from "./textWidth.ts";
import Timeline from "./Timeline.tsx";

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;

describe("Timeline (#326, redesigned #390)", () => {
  it("shows the month's own heading and note, and draws the zero axis", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(screen.getByText("September 2026, day by day")).toBeInTheDocument();
    expect(document.querySelector(".t-axis")).not.toBeNull();
  });

  it("draws the running total solid up to today, dashed for what is still scheduled", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 15,
      events: [
        { day: 5, amountCents: 10_000, direction: "out", status: "recorded" },
        { day: 20, amountCents: 5_000, direction: "in", status: "scheduled" },
      ],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(document.querySelector(".t-line.t-out:not(.plan)")).not.toBeNull();
    expect(document.querySelector(".t-line.t-in.plan")).not.toBeNull();
  });

  it("shows the current value, signed, at today's own line", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 15,
      events: [{ day: 5, amountCents: 4_200, direction: "in", status: "recorded" }],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(screen.getByText("+€42.00")).toBeInTheDocument();
  });

  it("gives an overdue, not-yet-recorded item its own marker, without changing the current value's own colour", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 15,
      events: [{ day: 5, amountCents: 4_500, direction: "out", status: "overdue" }],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(document.querySelector(".t-overdue")).not.toBeNull();
    // The real total is unaffected until it is actually recorded.
    expect(screen.getByText("+€0.00")).toBeInTheDocument();
  });

  it("draws the 'today' line and the current value only when the month shown is the current one", () => {
    const current = computeTimeline({ daysInMonth: 30, today: 12, events: [] });
    const { rerender } = render(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Timeline layout={current} monthLabel="September 2026" money={money} />
      </IntlProvider>,
    );
    expect(document.querySelector(".t-today")).not.toBeNull();
    expect(document.querySelector(".t-cur")).not.toBeNull();

    const other = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    rerender(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Timeline layout={other} monthLabel="September 2026" money={money} />
      </IntlProvider>,
    );
    expect(document.querySelector(".t-today")).toBeNull();
    expect(document.querySelector(".t-cur")).toBeNull();
  });

  it("drops the heading, note and current-value label in compact mode, for the phone's own small timeline (#331)", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: 12, events: [], compact: true });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} compact />);

    expect(screen.queryByText("September 2026, day by day")).not.toBeInTheDocument();
    expect(screen.queryByText(/What has moved/)).not.toBeInTheDocument();
    expect(document.querySelector(".time.compact")).not.toBeNull();
    expect(document.querySelector(".t-axis")).not.toBeNull();
    // Still drawn (compact just trims the surrounding chrome, not the chart itself).
    expect(document.querySelector(".t-cur")).not.toBeNull();
  });

  it("names the month on its own first day tick, so the x-axis says which month it is (#406)", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" monthAbbrev="Sep" money={money} />);

    expect(screen.getByText("Sep 1")).toBeInTheDocument();
  });

  it("keeps a bare day number on the first tick in compact mode, where space is already tight", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [], compact: true });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" monthAbbrev="Sep" money={money} compact />);

    expect(screen.queryByText("Sep 1")).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("marks a few round money amounts along the vertical scale, each with its own label (#405)", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [{ day: 15, amountCents: 100_000, direction: "in", status: "recorded" }],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(layout.valueTicks.length).toBeGreaterThan(0);
    for (const tick of layout.valueTicks) {
      expect(screen.getByText(money(tick.amountCents))).toBeInTheDocument();
    }
    // One fewer gridline than label: the tick that lands on zero shares the existing axis line.
    expect(document.querySelectorAll(".t-grid").length).toBe(layout.valueTicks.length - 1);
  });

  it("keeps the value labels in a gutter left of the plot, clear of the line, gridlines and future ground (#591)", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 12,
      events: [
        { day: 1, amountCents: 400_000, direction: "in", status: "recorded" },
        { day: 3, amountCents: 150_000, direction: "out", status: "recorded" },
        { day: 20, amountCents: 90_000, direction: "out", status: "scheduled" },
      ],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" monthAbbrev="Sep" money={money} />);

    const num = (el: Element, name: string): number => Number(el.getAttribute(name));
    const labels = [...document.querySelectorAll(".t-grid-l")];
    expect(labels.length).toBe(layout.valueTicks.length);
    // Everything drawn in the plot starts at or right of the plot's own left edge...
    const plotLeft = Math.min(
      ...[...document.querySelectorAll(".t-grid, .t-axis, .t-line, .t-cur")].flatMap((el) => [num(el, "x1"), num(el, "x2")]),
      ...[...document.querySelectorAll(".t-future")].map((el) => num(el, "x")),
    );
    expect(plotLeft).toBe(layout.axisX0);
    // ...and every label ends, right-aligned, before it.
    for (const label of labels) {
      expect(label.getAttribute("text-anchor")).toBe("end");
      expect(num(label, "x")).toBeLessThan(plotLeft);
      expect(num(label, "x")).toBeGreaterThanOrEqual(70);
    }
  });

  it.each([
    ["CHF, en", (cents: number) => formatMoney(cents, { locale: "en", currency: "CHF" })],
    ["USD, it", (cents: number) => formatMoney(cents, { locale: "it", currency: "USD" })],
    ["EUR, it", (cents: number) => formatMoney(cents, { locale: "it", currency: "EUR" })],
  ])("sizes the label gutter from the widest formatted label, long negatives included (%s, #591)", (_name, wideMoney) => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [
        { day: 3, amountCents: 12_000_000, direction: "out", status: "recorded" },
        { day: 9, amountCents: 5_000_000, direction: "in", status: "recorded" },
      ],
      valueLabelWidth: timelineValueLabelWidth(wideMoney),
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={wideMoney} />);

    const labels = [...document.querySelectorAll(".t-grid-l")];
    expect(labels.some((label) => label.textContent?.startsWith("-"))).toBe(true);
    for (const label of labels) {
      // Right-aligned at `x`, so the label starts at x - width: never left of the canvas's own edge.
      expect(Number(label.getAttribute("x")) - estimateTextWidth(label.textContent ?? "", 10)).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([1, 2])("puts the 'today' label right of its line on day %i, clear of the value labels' gutter (#591)", (day) => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: day,
      events: [{ day: 1, amountCents: 400_000, direction: "in", status: "recorded" }],
      valueLabelWidth: timelineValueLabelWidth(money),
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    const label = screen.getByText("today");
    expect(label.getAttribute("text-anchor")).toBe("start");
    expect(Number(label.getAttribute("x"))).toBeGreaterThan(layout.axisX0);
  });

  it("keeps the 'today' label left of its line later in the month", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: 15, events: [], valueLabelWidth: timelineValueLabelWidth(money) });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    const label = screen.getByText("today");
    expect(label.getAttribute("text-anchor")).toBe("end");
    expect(Number(label.getAttribute("x")) - estimateTextWidth("today", 12)).toBeGreaterThanOrEqual(layout.axisX0);
  });

  it("drops the vertical scale's own reference lines in compact mode", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [{ day: 15, amountCents: 100_000, direction: "in", status: "recorded" }],
      compact: true,
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} compact />);

    expect(document.querySelectorAll(".t-grid-l")).toHaveLength(0);
  });
});
