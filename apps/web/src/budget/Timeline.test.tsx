import { computeTimeline } from "@envelope/core";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import Timeline from "./Timeline.tsx";

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;

describe("Timeline (#326)", () => {
  it("shows the month's own heading and note, and draws the axis", () => {
    const layout = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(screen.getByText("September 2026, day by day")).toBeInTheDocument();
    expect(document.querySelector(".t-axis")).not.toBeNull();
  });

  it("draws a solid stem for a recorded outflow, dashed for one still scheduled", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      events: [
        { day: 5, amountCents: 10_000, direction: "out", status: "recorded", payee: "Supermarket" },
        { day: 10, amountCents: 5_000, direction: "out", status: "scheduled", payee: "Rent" },
      ],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(document.querySelector(".t-stem.t-out:not(.plan)")).not.toBeNull();
    expect(document.querySelector(".t-stem.t-out.plan")).not.toBeNull();
  });

  it("gives an overdue item its own amber, dashed stem and label", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: 15,
      events: [{ day: 5, amountCents: 4_500, direction: "out", status: "overdue", payee: "Vet clinic" }],
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    expect(document.querySelector(".t-stem.t-late")).not.toBeNull();
    expect(document.querySelector(".t-l.t-late")).toHaveTextContent("Vet clinic");
  });

  it("shows at most two payees plus a count, never more, for a day with many events", () => {
    const layout = computeTimeline({
      daysInMonth: 30,
      today: undefined,
      formatAmount: money,
      events: [1, 2, 3, 4, 5].map((n) => ({ day: 10, amountCents: 100 * n, direction: "in" as const, status: "recorded" as const, payee: `Payee ${n}` })),
    });
    renderWithIntl(<Timeline layout={layout} monthLabel="September 2026" money={money} />);

    // Intl.ListFormat's own conjunction style ("A and B"), never a raw "+3" that could be
    // mistaken for the timeline's own "+" sign (an inflow) — design.md, #326's own review round.
    expect(screen.getByText(/Payee 1 and Payee 2 and 3 more/)).toBeInTheDocument();
  });

  it("draws the 'today' line only when the month shown is the current one", () => {
    const current = computeTimeline({ daysInMonth: 30, today: 12, events: [] });
    const { rerender } = render(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Timeline layout={current} monthLabel="September 2026" money={money} />
      </IntlProvider>,
    );
    expect(document.querySelector(".t-today")).not.toBeNull();

    const other = computeTimeline({ daysInMonth: 30, today: undefined, events: [] });
    rerender(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Timeline layout={other} monthLabel="September 2026" money={money} />
      </IntlProvider>,
    );
    expect(document.querySelector(".t-today")).toBeNull();
  });
});
