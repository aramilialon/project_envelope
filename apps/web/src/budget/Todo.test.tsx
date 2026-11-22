import type { TodoItem } from "@envelope/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import Todo from "./Todo.tsx";

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const categoryNameById = new Map([
  ["groceries", "Groceries"],
  ["vacation", "Vacation"],
  ["emergency-fund", "Emergency fund"],
]);

describe("Todo (#326)", () => {
  it("says there is nothing to fix when the list is empty", () => {
    renderWithIntl(<Todo items={[]} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("Nothing to fix this month.")).toBeInTheDocument();
    expect(document.querySelector(".todo-i")).toBeNull();
  });

  it("shows the list's own count next to the heading", () => {
    const items: TodoItem[] = [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("1 thing")).toBeInTheDocument();
  });

  it("gives cash overspending a red dot and the category's own name", () => {
    const items: TodoItem[] = [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("Cover Groceries")).toBeInTheDocument();
    expect(document.querySelector(".dot.r")).not.toBeNull();
  });

  it("says when a cash overspending item also asks for what is scheduled (#728)", () => {
    const items: TodoItem[] = [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 3_500, reservationShortfallCents: 3_000 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("overspent in cash and short for what is scheduled; the cash part, if still uncovered when the month ends, comes out of next month's unassigned money")).toBeInTheDocument();
    expect(screen.queryByText("overspent in cash; if still uncovered when the month ends, it comes out of next month's unassigned money")).toBeNull();
  });

  it("says when a category asks its card spending with what is scheduled, and how much of a card's debt is asked there (#731)", () => {
    const names = new Map([...categoryNameById, ["restaurants", "Restaurants"], ["visa", "Visa"], ["mc", "Mastercard"]]);
    const items: TodoItem[] = [
      { kind: "cashOverspending", categoryId: "groceries", amountCents: 2_000, reservationShortfallCents: 500, cardSpendingCents: 1_000 },
      { kind: "reservationShortfall", categoryId: "restaurants", amountCents: 4_000, cardSpendingCents: 3_000 },
      { kind: "cardDebtUncovered", categoryId: "visa", amountCents: 2_000, askedOnCategories: [{ categoryId: "restaurants", amountCents: 3_000 }] },
      {
        kind: "cashOverspending",
        categoryId: "mc",
        amountCents: 600,
        askedOnCategories: [
          { categoryId: "groceries", amountCents: 1_000 },
          { categoryId: "restaurants", amountCents: 500 },
        ],
      },
    ];
    renderWithIntl(<Todo items={items} categoryNameById={names} money={money} locale="en" />);
    expect(screen.getByText("overspent in cash and with a card, and short for what is scheduled; the cash part, if still uncovered when the month ends, comes out of next month's unassigned money")).toBeInTheDocument();
    expect(screen.getByText("includes €30.00 spent with a card, covered first by money assigned here")).toBeInTheDocument();
    expect(screen.getByText("€30.00 of the card's debt is included in what Restaurants still needs")).toBeInTheDocument();
    expect(screen.getByText("€15.00 of the card's debt is included in what 2 categories still need")).toBeInTheDocument();
  });

  it("gives a reservation shortfall and uncovered card debt an amber dot", () => {
    const items: TodoItem[] = [
      { kind: "reservationShortfall", categoryId: "groceries", amountCents: 500 },
      { kind: "cardDebtUncovered", categoryId: "groceries", amountCents: 500 },
    ];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(document.querySelectorAll(".dot.w")).toHaveLength(2);
  });

  it("composes a sentence for an overdue scheduled transaction, with its own payee and date", () => {
    const items: TodoItem[] = [
      { kind: "scheduledOverdue", scheduledTransactionId: "s1", categoryId: "groceries", payee: "Vet clinic", date: "2026-09-22", amountCents: 4_500 },
    ];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("Record Vet clinic")).toBeInTheDocument();
    expect(screen.getByText(/Sep 22/)).toBeInTheDocument();
  });

  it("names a single target by its own category, and counts several", () => {
    const one: TodoItem[] = [{ kind: "targetsNeeded", categoryIds: ["vacation"], amountCents: 1_000 }];
    const { rerender } = render(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Todo items={one} categoryNameById={categoryNameById} money={money} locale="en" />
      </IntlProvider>,
    );
    expect(screen.getByText("Fund the Vacation target")).toBeInTheDocument();

    const many: TodoItem[] = [{ kind: "targetsNeeded", categoryIds: ["vacation", "emergency-fund"], amountCents: 2_000 }];
    rerender(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Todo items={many} categoryNameById={categoryNameById} money={money} locale="en" />
      </IntlProvider>,
    );
    expect(screen.getByText("Fund 2 targets")).toBeInTheDocument();
  });

  it("shows being assigned more than there is money for, with no category name needed", () => {
    const items: TodoItem[] = [{ kind: "overassigned", amountCents: 500 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("You assigned more than you have")).toBeInTheDocument();
  });

  it("shows every item's own amount", () => {
    const items: TodoItem[] = [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_234 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.getByText("€12.34")).toBeInTheDocument();
  });

  it("caps the list to 'limit' items, with a '+N more' line for the rest (#331)", () => {
    const items: TodoItem[] = [
      { kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 },
      { kind: "scheduledOverdue", scheduledTransactionId: "s1", categoryId: "groceries", payee: "Vet clinic", date: "2026-09-22", amountCents: 500 },
      { kind: "reservationShortfall", categoryId: "groceries", amountCents: 500 },
      { kind: "cardDebtUncovered", categoryId: "groceries", amountCents: 500 },
    ];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" limit={3} />);
    expect(document.querySelectorAll(".todo-i")).toHaveLength(3);
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("shows every item, with no '+N more' line, when there are no more than 'limit'", () => {
    const items: TodoItem[] = [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" limit={3} />);
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it("makes an item clickable and opens its own category, when onItemClick is given — but not 'overassigned', which names no single one", () => {
    const items: TodoItem[] = [
      { kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 },
      { kind: "overassigned", amountCents: 500 },
    ];
    const onItemClick = vi.fn();
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" onItemClick={onItemClick} />);

    fireEvent.click(screen.getByRole("button", { name: /Cover Groceries/ }));
    expect(onItemClick).toHaveBeenCalledWith(items[0]);
    expect(screen.queryByRole("button", { name: /assigned more/ })).not.toBeInTheDocument();
  });

  it("stays plain, informational text when no onItemClick is given at all", () => {
    const items: TodoItem[] = [{ kind: "cashOverspending", categoryId: "groceries", amountCents: 1_000 }];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(screen.queryByRole("button", { name: /Cover Groceries/ })).not.toBeInTheDocument();
  });
});
