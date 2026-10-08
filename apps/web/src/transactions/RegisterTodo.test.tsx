import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import RegisterTodo from "./RegisterTodo.tsx";
import type { RegisterTodoItem } from "./registerTodo.ts";

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;

describe("RegisterTodo (#337)", () => {
  it("renders nothing when there is nothing to do", () => {
    const { container } = renderWithIntl(<RegisterTodo items={[]} money={money} locale="en" onRecord={vi.fn()} onMark={vi.fn()} onReconcile={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an overdue scheduled transaction and calls onRecord when clicked", () => {
    const items: RegisterTodoItem[] = [{ kind: "recordOverdue", scheduledTransactionId: "s1", payee: "Internet provider", date: "2026-10-01", amountCents: 4_500 }];
    const onRecord = vi.fn();
    renderWithIntl(<RegisterTodo items={items} money={money} locale="en" onRecord={onRecord} onMark={vi.fn()} onReconcile={vi.fn()} />);

    expect(screen.getByText("Record Internet provider")).toBeInTheDocument();
    expect(screen.getByText(/scheduled for Oct 1, not yet in the account/)).toBeInTheDocument();
    expect(screen.getByText("€45.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Record Internet provider/ }));
    expect(onRecord).toHaveBeenCalledWith("s1");
  });

  it("shows a pending transaction and calls onMark when clicked", () => {
    const items: RegisterTodoItem[] = [{ kind: "markPending", transactionId: "t1", payee: "Streaming service", date: "2026-10-06", amountCents: 999 }];
    const onMark = vi.fn();
    renderWithIntl(<RegisterTodo items={items} money={money} locale="en" onRecord={vi.fn()} onMark={onMark} onReconcile={vi.fn()} />);

    expect(screen.getByText("Mark Streaming service")).toBeInTheDocument();
    expect(screen.getByText(/still awaiting the bank/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Mark Streaming service/ }));
    expect(onMark).toHaveBeenCalledWith("t1");
  });

  it("shows the reconcile item and calls onReconcile when clicked (#60)", () => {
    const items: RegisterTodoItem[] = [{ kind: "reconcile", clearedCount: 19, clearedCents: 1_262_216 }];
    const onReconcile = vi.fn();
    renderWithIntl(<RegisterTodo items={items} money={money} locale="en" onRecord={vi.fn()} onMark={vi.fn()} onReconcile={onReconcile} />);

    expect(screen.getByText("Reconcile the account")).toBeInTheDocument();
    expect(screen.getByText("19 transactions cleared")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reconcile the account/ }));
    expect(onReconcile).toHaveBeenCalled();
  });

  it("caps the list to 'limit' items, with a '+N more' line for the rest", () => {
    const items: RegisterTodoItem[] = [
      { kind: "recordOverdue", scheduledTransactionId: "s1", payee: "A", date: "2026-10-01", amountCents: 100 },
      { kind: "markPending", transactionId: "t1", payee: "B", date: "2026-10-02", amountCents: 100 },
      { kind: "reconcile", clearedCount: 3, clearedCents: 300 },
    ];
    renderWithIntl(<RegisterTodo items={items} money={money} locale="en" limit={2} onRecord={vi.fn()} onMark={vi.fn()} onReconcile={vi.fn()} />);

    expect(document.querySelectorAll(".todo-i")).toHaveLength(2);
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });
});
