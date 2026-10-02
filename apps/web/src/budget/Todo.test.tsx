import type { TodoItem } from "@envelope/core";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";

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

  it("gives card overspending, a reservation shortfall and uncovered card debt an amber dot", () => {
    const items: TodoItem[] = [
      { kind: "cardOverspending", categoryId: "groceries", amountCents: 500 },
      { kind: "reservationShortfall", categoryId: "groceries", amountCents: 500 },
      { kind: "cardDebtUncovered", categoryId: "groceries", amountCents: 500 },
    ];
    renderWithIntl(<Todo items={items} categoryNameById={categoryNameById} money={money} locale="en" />);
    expect(document.querySelectorAll(".dot.w")).toHaveLength(3);
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
});
