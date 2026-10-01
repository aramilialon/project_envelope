import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BudgetMonthCategory } from "../budget/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as targetsApi from "./api.ts";
import type { GoalProgress } from "./api.ts";
import TargetsPanel from "./TargetsPanel.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function category(overrides: Partial<BudgetMonthCategory>): BudgetMonthCategory {
  return {
    categoryId: "cat-1",
    name: "Groceries",
    groupId: "g1",
    groupName: "Home",
    sortOrder: 1,
    carriedOver: 0,
    assigned: 2000,
    activity: -1000,
    available: 1000,
    creditOverspending: 0,
    cashOverspending: 0,
    reserved: 0,
    uncovered: 0,
    ...overrides,
  };
}

function goalProgress(overrides: Partial<GoalProgress["goal"]> = {}): GoalProgress {
  return {
    goal: {
      id: "goal-1",
      workspaceId: "ws-1",
      categoryId: "cat-1",
      kind: "monthly",
      amountCents: 6000,
      dueMonth: null,
      every: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      ...overrides,
    },
    asks: 6000,
    missing: 4000,
    progress: 1 / 3,
  };
}

function renderPanel(categories: BudgetMonthCategory[]) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const rendered = renderWithIntl(
    <TargetsPanel workspaceId="ws-1" month="2026-09" categories={categories} currency="EUR" onClose={onClose} onChanged={onChanged} />,
  );
  return { ...rendered, onClose, onChanged };
}

describe("TargetsPanel (#55)", () => {
  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(targetsApi, "getGoal").mockReturnValue(new Promise(() => {}));
    renderWithIntl(<TargetsPanel workspaceId="ws-1" month="2026-09" categories={[category({})]} currency="EUR" onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your targets…");
  });

  it("lists a category without a target under 'No target yet', with '+ Add'", async () => {
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(undefined);
    renderPanel([category({})]);

    expect(await screen.findByText("No target yet")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add" })).toBeInTheDocument();
  });

  it("groups a category with a target by its kind, showing what it still asks", async () => {
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(goalProgress());
    renderPanel([category({})]);

    expect(await screen.findByText("Monthly amount")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText(/missing/)).toHaveTextContent("Asks €60.00, €40.00 missing");
  });

  it("opens the target editor for a category, and back again on close", async () => {
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(goalProgress());
    renderPanel([category({})]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    expect(await screen.findByRole("heading", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toHaveValue("60.00");
  });

  it("funds all targets and reports the change", async () => {
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(goalProgress());
    const runQuickAssign = vi.spyOn(targetsApi, "runQuickAssign").mockResolvedValue(undefined);
    const { onChanged } = renderPanel([category({})]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Fund all targets" }));

    await waitFor(() => expect(runQuickAssign).toHaveBeenCalledWith("t", "ws-1", "2026-09", { kind: "all" }, "fund_targets"));
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
