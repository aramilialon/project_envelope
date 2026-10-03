import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as budgetApi from "./api.ts";
import MoveMoneyForm, { type MoveMoneyInitial } from "./MoveMoneyForm.tsx";
import type { BudgetGroup, BudgetGroupCategory } from "./useBudgetMonth.ts";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function categoryIn(overrides: Partial<BudgetGroupCategory>): BudgetGroupCategory {
  return {
    categoryId: "cat-1",
    name: "Groceries",
    groupId: "g1",
    groupName: "Home",
    sortOrder: 1,
    carriedOver: 0,
    assigned: 0,
    activity: 0,
    available: 0,
    creditOverspending: 0,
    cashOverspending: 0,
    reserved: 0,
    uncovered: 0,
    isPaymentCategory: false,
    ...overrides,
  };
}

const GROUPS: readonly BudgetGroup[] = [
  {
    id: "g1",
    name: "Home",
    categories: [
      categoryIn({ categoryId: "groceries", name: "Groceries", available: 10_000 }),
      categoryIn({ categoryId: "restaurants", name: "Restaurants", available: -2_000, cashOverspending: 2_000 }),
    ],
  },
  {
    id: "g2",
    name: "Fun",
    categories: [categoryIn({ categoryId: "hobbies", name: "Hobbies", groupId: "g2", groupName: "Fun", available: 5_000 })],
  },
];

function renderForm(initial: MoveMoneyInitial, overrides: Partial<Parameters<typeof MoveMoneyForm>[0]> = {}) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  const createAssignments = vi.spyOn(budgetApi, "createAssignments").mockResolvedValue(undefined);
  const onClose = vi.fn();
  const onChanged = vi.fn();
  renderWithIntl(
    <MoveMoneyForm
      workspaceId="ws-1"
      month="2026-10"
      unassignedCents={1_000}
      assignedInFutureCents={0}
      groups={GROUPS}
      currency="EUR"
      initial={initial}
      onClose={onClose}
      onChanged={onChanged}
      {...overrides}
    />,
  );
  return { createAssignments, onClose, onChanged };
}

describe("MoveMoneyForm (#328)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'Assign' starts from unassigned money, with no destination chosen yet", () => {
    renderForm({ kind: "assign" });
    expect(screen.getByRole("heading", { name: "Assign" })).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveValue("unassigned");
    expect(screen.getByLabelText("To")).toHaveValue("");
  });

  it("assigning to a category shows a live preview of both sides, and submits one ledger entry", async () => {
    const { createAssignments, onChanged } = renderForm({ kind: "assign" });

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "groceries" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5.00" } });

    const lines = [...document.querySelectorAll(".ba .n")].map((el) => el.textContent);
    expect(lines).toContain("€10.00 → €5.00"); // Unassigned
    expect(lines).toContain("€100.00 → €105.00"); // Groceries
    fireEvent.click(screen.getByRole("button", { name: "Assign €5.00" }));

    await waitFor(() =>
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: null, destinationCategoryId: "groceries", amountCents: 500 },
      ]),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("assigning more than is unassigned shows a warning, but still allows it", () => {
    renderForm({ kind: "assign" });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "groceries" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } }); // unassigned is only €10.00

    expect(screen.getByText(/Unassigned will go below zero/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign €50.00" })).not.toBeDisabled();
  });

  it("offers assigning to one of the next two months, only once a real category is chosen", () => {
    renderForm({ kind: "assign" });
    expect(screen.queryByLabelText("For the month")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "groceries" } });
    expect(screen.getByLabelText("For the month")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5.00" } });
    fireEvent.change(screen.getByLabelText("For the month"), { target: { value: "2026-11" } });
    expect(screen.getByText(/Already assigned to November 2026/)).toBeInTheDocument();
  });

  it("moving money between two categories, back to unassigned", async () => {
    const { createAssignments } = renderForm({ kind: "assign" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "groceries" } });
    expect(screen.getByRole("heading", { name: "Move money" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "unassigned" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "15.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Move €15\.00/ }));

    await waitFor(() =>
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: "groceries", destinationCategoryId: null, amountCents: 1_500 },
      ]),
    );
  });

  it("'Move money' from a category's row preselects it and the amount it is missing", () => {
    renderForm({ kind: "moveTo", categoryId: "restaurants" });
    expect(screen.getByLabelText("To")).toHaveValue("restaurants");
    expect(screen.getByLabelText("Amount")).toHaveValue("20.00"); // restaurants is €20.00 cash-overspent
  });

  it("preselects a category able to cover the gap as the source, when unassigned money cannot", () => {
    renderForm({ kind: "moveTo", categoryId: "restaurants" }, { unassignedCents: 500 }); // needs €20.00, only €5.00 unassigned
    expect(screen.getByLabelText("From")).toHaveValue("groceries"); // the first other category with enough available
  });

  it("the same category as both source and destination is an error, blocking submission", () => {
    renderForm({ kind: "assign" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "groceries" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "groceries" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5.00" } });

    expect(screen.getByText("The source and destination are the same.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Move/ })).toBeDisabled();
  });

  it("moving more than a category has available is an error naming it", () => {
    renderForm({ kind: "assign" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "groceries" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "hobbies" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "200.00" } }); // groceries only has €100.00

    expect(screen.getByText("Groceries has only €100.00 available.")).toBeInTheDocument();
  });

  it("the Cancel button calls onClose", () => {
    const { onClose } = renderForm({ kind: "assign" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
