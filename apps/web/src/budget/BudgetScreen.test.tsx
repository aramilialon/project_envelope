import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import * as categoriesApi from "../categories/api.ts";
import type { CategoryGroup } from "../categories/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as targetsApi from "../targets/api.ts";
import * as workspacesApi from "../workspaces/api.ts";
import * as budgetApi from "./api.ts";
import type { BudgetMonthCategory, BudgetMonthResponse } from "./api.ts";
import BudgetScreen from "./BudgetScreen.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const HOME: CategoryGroup = { id: "g1", workspaceId: "ws-1", name: "Home", sortOrder: 1, archived: false };
const FUN: CategoryGroup = { id: "g2", workspaceId: "ws-1", name: "Fun", sortOrder: 2, archived: false };

function category(overrides: Partial<BudgetMonthCategory>): BudgetMonthCategory {
  return {
    categoryId: "c1",
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
    ...overrides,
  };
}

function budgetMonth(overrides: Partial<BudgetMonthResponse>): BudgetMonthResponse {
  return {
    month: "2026-09",
    unassigned: 0,
    assignedInFuture: 0,
    overspentLastMonth: 0,
    creditOverspending: 0,
    reserved: 0,
    categories: [],
    paymentCategories: [],
    ...overrides,
  };
}

function renderScreen(month: BudgetMonthResponse, groups: CategoryGroup[]) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR" },
  ]);
  vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue(groups);
  const getBudgetMonth = vi.spyOn(budgetApi, "getBudgetMonth").mockResolvedValue(month);
  const rendered = renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1"]}>
      <Routes>
        <Route path="/:workspaceId" element={<BudgetScreen />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...rendered, getBudgetMonth };
}

describe("BudgetScreen (#53)", () => {
  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise(() => {}));
    vi.spyOn(categoriesApi, "listCategoryGroups").mockReturnValue(new Promise(() => {}));
    vi.spyOn(budgetApi, "getBudgetMonth").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<BudgetScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading your budget…");
  });

  it("shows an error state", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([]);
    vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue([]);
    vi.spyOn(budgetApi, "getBudgetMonth").mockRejectedValue(new Error("network"));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<BudgetScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your budget.");
  });

  it("shows the ready-to-assign amount and every category grouped and ordered", async () => {
    renderScreen(
      budgetMonth({
        unassigned: 10000,
        categories: [
          category({ categoryId: "c2", groupId: "g2", groupName: "Fun", name: "Hobby", assigned: 2000, activity: -500, available: 1500 }),
          category({ categoryId: "c1", groupId: "g1", name: "Groceries", assigned: 6000, activity: -4000, available: 2000 }),
        ],
      }),
      [HOME, FUN],
    );

    expect(await screen.findByText("€100.00")).toBeInTheDocument();
    const rowNames = (await screen.findAllByRole("row")).map((row) => row.textContent);
    const homeIndex = rowNames.findIndex((t) => t?.includes("Home"));
    const groceriesIndex = rowNames.findIndex((t) => t?.includes("Groceries"));
    const funIndex = rowNames.findIndex((t) => t?.includes("Fun"));
    const hobbyIndex = rowNames.findIndex((t) => t?.includes("Hobby"));
    expect(homeIndex).toBeLessThan(groceriesIndex);
    expect(groceriesIndex).toBeLessThan(funIndex);
    expect(funIndex).toBeLessThan(hobbyIndex);
  });

  it("shows a negative ready-to-assign amount and a negative available amount distinctly", async () => {
    renderScreen(
      budgetMonth({
        unassigned: -500,
        categories: [category({ available: -200 })],
      }),
      [HOME],
    );

    expect(await screen.findByText("-€5.00")).toBeInTheDocument();
    const cell = document.querySelector("td.neg");
    expect(cell).toHaveTextContent("-€2.00");
  });

  it("shows an empty message when there are no categories yet", async () => {
    renderScreen(budgetMonth({}), []);
    expect(await screen.findByText("No categories yet: add some from Workspace settings.")).toBeInTheDocument();
  });

  it("navigates to the next and previous month, refetching the budget", async () => {
    const { getBudgetMonth } = renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Home");
    const initialCall = getBudgetMonth.mock.calls[0];
    const currentMonth = initialCall?.[2] as string;
    const [year, monthNumber] = currentMonth.split("-").map(Number) as [number, number];
    const pad = (n: number) => String(n).padStart(2, "0");
    const nextMonth = monthNumber === 12 ? `${year + 1}-01` : `${year}-${pad(monthNumber + 1)}`;
    const previousMonth = monthNumber === 1 ? `${year - 1}-12` : `${year}-${pad(monthNumber - 1)}`;

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("Home")).toBeInTheDocument();
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", nextMonth);

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("Home")).toBeInTheDocument();
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", previousMonth);
  });

  it("opens the Targets panel", async () => {
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(undefined);
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Home");

    fireEvent.click(screen.getByRole("button", { name: "Targets" }));
    expect(await screen.findByRole("heading", { name: "Targets" })).toBeInTheDocument();
  });

  it("opens the Quick assign panel", async () => {
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Home");

    fireEvent.click(screen.getByRole("button", { name: "Quick assign" }));
    expect(await screen.findByRole("heading", { name: "Quick assign" })).toBeInTheDocument();
  });
});
