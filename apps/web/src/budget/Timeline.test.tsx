import { computeTimeline } from "@envelope/core";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
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
