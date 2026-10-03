import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as categoriesApi from "../categories/api.ts";
import type { CategoryGroup } from "../categories/api.ts";
import { BandSecondRowSlotContext } from "../layout/bandSecondRowSlot.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as targetsApi from "../targets/api.ts";
import type { GoalProgress } from "../targets/api.ts";
import * as workspacesApi from "../workspaces/api.ts";
import * as budgetApi from "./api.ts";
import type { BudgetMonthCategory, BudgetMonthResponse, MonthEvent } from "./api.ts";
import BudgetScreen from "./BudgetScreen.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const HOME: CategoryGroup = { id: "g1", workspaceId: "ws-1", name: "Home", sortOrder: 1, archived: false };
const FUN: CategoryGroup = { id: "g2", workspaceId: "ws-1", name: "Fun", sortOrder: 2, archived: false };

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

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

/** Stands in for `AppLayout`'s own band second-row slot, the same way the real layout provides it. */
function Harness({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setSlot} />
      <BandSecondRowSlotContext.Provider value={slot}>{children}</BandSecondRowSlotContext.Provider>
    </>
  );
}

function renderScreen(
  month: BudgetMonthResponse,
  groups: CategoryGroup[],
  events: readonly MonthEvent[] = [],
  goalsByCategory: ReadonlyMap<string, GoalProgress> = new Map(),
  eventsImpl?: () => Promise<readonly MonthEvent[]>,
) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "UTC" },
  ]);
  vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue(groups);
  const getBudgetMonth = vi.spyOn(budgetApi, "getBudgetMonth").mockResolvedValue(month);
  vi.spyOn(budgetApi, "getBudgetMonthEvents").mockImplementation(eventsImpl ?? (() => Promise.resolve(events)));
  vi.spyOn(targetsApi, "getGoal").mockImplementation((_t, _w, categoryId) => Promise.resolve(goalsByCategory.get(categoryId)));
  const rendered = renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1"]}>
      <Routes>
        <Route
          path="/:workspaceId"
          element={
            <Harness>
              <BudgetScreen />
            </Harness>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...rendered, getBudgetMonth };
}

describe("BudgetScreen (#53, #324)", () => {
  afterEach(() => {
    setWidth(ORIGINAL_WIDTH);
    vi.useRealTimers();
  });

  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise(() => {}));
    vi.spyOn(categoriesApi, "listCategoryGroups").mockReturnValue(new Promise(() => {}));
    vi.spyOn(budgetApi, "getBudgetMonth").mockReturnValue(new Promise(() => {}));
    vi.spyOn(budgetApi, "getBudgetMonthEvents").mockReturnValue(new Promise(() => {}));
    vi.spyOn(targetsApi, "getGoal").mockReturnValue(new Promise(() => {}));
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
    vi.spyOn(budgetApi, "getBudgetMonthEvents").mockResolvedValue([]);
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(undefined);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<BudgetScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your budget.");
  });

  it("shows an empty message when there are no categories yet", async () => {
    renderScreen(budgetMonth({}), []);
    expect(await screen.findByText("No categories yet: add some from Workspace settings.")).toBeInTheDocument();
  });

  it("portals the unassigned amount into the band's second row, turning red when negative", async () => {
    renderScreen(budgetMonth({ unassigned: -500, categories: [category({})] }), [HOME]);
    expect(await screen.findByText("-€5.00")).toBeInTheDocument();
    expect(screen.getByText("-€5.00")).toHaveClass("low");
  });

  it("groups categories under their own group, in group and category order", async () => {
    const { container } = renderScreen(
      budgetMonth({
        categories: [
          category({ categoryId: "c2", groupId: "g2", groupName: "Fun", name: "Hobby", sortOrder: 1 }),
          category({ categoryId: "c1", groupId: "g1", name: "Groceries", sortOrder: 1 }),
        ],
      }),
      [HOME, FUN],
    );
    await screen.findByText("Groceries");

    const text = container.textContent ?? "";
    const homeIndex = text.indexOf("Home");
    const groceriesIndex = text.indexOf("Groceries");
    const funIndex = text.indexOf("Fun");
    const hobbyIndex = text.indexOf("Hobby");
    expect(homeIndex).toBeLessThan(groceriesIndex);
    expect(groceriesIndex).toBeLessThan(funIndex);
    expect(funIndex).toBeLessThan(hobbyIndex);
  });

  it("shows a group's own available sum and its overspent-category count", async () => {
    renderScreen(
      budgetMonth({
        categories: [
          category({ categoryId: "c1", name: "Groceries", activity: -200, available: -200, cashOverspending: 200 }),
          category({ categoryId: "c2", name: "Fuel", available: 300 }),
        ],
      }),
      [HOME],
    );
    await screen.findByText("Groceries");

    expect(screen.getByText("€1.00")).toBeInTheDocument(); // -200 + 300 = 100
    expect(document.querySelector(".count.over")).toHaveTextContent("1"); // one overspent category, scoped: the timeline's own day-1 tick is also "1"
  });

  it("marks a cash-overspent category distinctly, with a screen-reader-only 'Overspent:' prefix", async () => {
    const { container } = renderScreen(
      budgetMonth({ categories: [category({ activity: -200, available: -200, cashOverspending: 200 })] }),
      [HOME],
    );
    await screen.findByText("Groceries");

    const cell = container.querySelector(".amt-cell.cash");
    expect(cell).not.toBeNull();
    expect(cell).toHaveTextContent("Overspent:");
    expect(cell).toHaveTextContent("-€2.00");
  });

  it("marks a card-overspent category with a 'Card' tag", async () => {
    const { container } = renderScreen(
      budgetMonth({ categories: [category({ activity: -485, available: -485, creditOverspending: 485 })] }),
      [HOME],
    );
    await screen.findByText("Groceries");
    expect(container.querySelector(".amt-cell.credit")).toHaveTextContent("Card");
  });

  it("marks a reservation beyond what is available with a 'Reserved' tag, never as overspending", async () => {
    const { container } = renderScreen(
      budgetMonth({ categories: [category({ carriedOver: 30_000, assigned: 5_000, available: -15_000, reserved: 50_000 })] }),
      [HOME],
    );
    await screen.findByText("Groceries");
    expect(container.querySelector(".amt-cell.short")).toHaveTextContent("Reserved");
  });

  it("shows the spent line for an ordinary category", async () => {
    renderScreen(
      budgetMonth({ categories: [category({ assigned: 60_000, activity: -64_215, available: -4_215, cashOverspending: 4_215 })] }),
      [HOME],
    );
    expect(await screen.findByText("€642.15 spent of €600.00")).toBeInTheDocument();
  });

  it("shows a payment category's debt line instead of a spent line", async () => {
    renderScreen(
      budgetMonth({
        categories: [],
        paymentCategories: [category({ categoryId: "pc1", name: "Visa payment", available: 50_000, uncovered: 70_000 })],
      }),
      [HOME],
    );
    expect(await screen.findByText("€700.00 to cover of €1,200.00 of debt")).toBeInTheDocument();
  });

  it("collapses and expands a group", async () => {
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Close Home" }));
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Home" }));
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
  });

  it("opens a category's own row detail on click, and closes it again on a second click (#327)", async () => {
    renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: 60_000 })] }), [HOME]);
    await screen.findByText("Groceries");

    const row = screen.getByRole("button", { name: /Groceries/ });
    fireEvent.click(row);
    expect(await screen.findByLabelText("Assigned this month")).toHaveValue("600.00");

    fireEvent.click(row);
    expect(screen.queryByLabelText("Assigned this month")).not.toBeInTheDocument();
  });

  it("refetches the budget month once the row detail changes the assigned amount (#327)", async () => {
    vi.spyOn(budgetApi, "createAssignments").mockResolvedValue(undefined);
    const { getBudgetMonth } = renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: 60_000 })] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    const input = await screen.findByLabelText("Assigned this month");
    input.focus();
    fireEvent.change(input, { target: { value: "700.00" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(getBudgetMonth).toHaveBeenCalledTimes(2));
  });

  it("a credit card's own payment category row stays non-interactive — it has no row detail of its own yet (#329)", async () => {
    renderScreen(budgetMonth({ categories: [], paymentCategories: [category({ categoryId: "pc1", name: "Visa payment" })] }), [HOME]);
    await screen.findByText("Visa payment");

    expect(screen.queryByRole("button", { name: /Visa payment/ })).not.toBeInTheDocument();
  });

  it("navigates to the next and previous month, refetching the budget", async () => {
    const { getBudgetMonth } = renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");
    const initialCall = getBudgetMonth.mock.calls[0];
    const currentMonth = initialCall?.[2] as string;
    const [year, monthNumber] = currentMonth.split("-").map(Number) as [number, number];
    const pad = (n: number) => String(n).padStart(2, "0");
    const nextMonth = monthNumber === 12 ? `${year + 1}-01` : `${year}-${pad(monthNumber + 1)}`;
    const previousMonth = monthNumber === 1 ? `${year - 1}-12` : `${year}-${pad(monthNumber - 1)}`;

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", nextMonth);

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", previousMonth);
  });

  it("picks the current month and 'today' in the workspace's own time zone, not the browser's", async () => {
    // Only `Date` is faked — `setTimeout`/`setInterval` stay real, since Testing Library's own
    // `findByText` polling relies on them.
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:30 UTC on 30 September is already 01:30 on 1 October in Rome (CEST, UTC+2) — a new month there, not here.
    vi.setSystemTime(new Date("2026-09-30T23:30:00.000Z"));
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue([HOME]);
    const getBudgetMonth = vi.spyOn(budgetApi, "getBudgetMonth").mockResolvedValue(budgetMonth({ categories: [category({})] }));
    vi.spyOn(budgetApi, "getBudgetMonthEvents").mockResolvedValue([]);
    vi.spyOn(targetsApi, "getGoal").mockResolvedValue(undefined);

    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<BudgetScreen />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Groceries");
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", "2026-10");
  });

  it("opens the 'Assign' form from the band's unassigned-money box (#328)", async () => {
    renderScreen(budgetMonth({ unassigned: 5_000, categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("heading", { name: "Assign" })).toBeInTheDocument();
  });

  it("opens 'Move money' from a category's own row, preselecting it as the destination (#328)", async () => {
    renderScreen(
      budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: 60_000, available: 60_000 })] }),
      [HOME],
    );
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Move money" }));

    expect(await screen.findByLabelText("To")).toHaveValue("c1");
  });

  it("opens the Targets panel", async () => {
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Targets" }));
    expect(await screen.findByRole("heading", { name: "Targets" })).toBeInTheDocument();
  });

  it("opens the Quick assign panel", async () => {
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Quick assign" }));
    expect(await screen.findByRole("heading", { name: "Quick assign" })).toBeInTheDocument();
  });

  it("shows the month's own timeline and 'To do' list, built from its events (#326)", async () => {
    const events: MonthEvent[] = [
      { date: "2026-01-05", amountCents: -8740, payee: "Supermarket", categoryId: "c1", kind: "recorded" },
      { date: "2026-01-12", amountCents: 245000, payee: "Salary", categoryId: null, kind: "recorded" },
    ];
    renderScreen(budgetMonth({ categories: [category({ cashOverspending: 5_000 })] }), [HOME], events);
    await screen.findByText("Groceries");

    expect(screen.getByText(/day by day/)).toBeInTheDocument();
    expect(document.querySelector(".time svg .t-stem.t-out")).not.toBeNull();
    expect(document.querySelector(".time svg .t-stem.t-in")).not.toBeNull();
    expect(screen.getByText("Cover Groceries")).toBeInTheDocument();
    expect(screen.getByText("€50.00")).toBeInTheDocument(); // the cash-overspending item's own amount
  });

  it("shows the 'To do' list as soon as the budget month itself is ready, without waiting for events", async () => {
    renderScreen(
      budgetMonth({ categories: [category({ cashOverspending: 5_000 })] }),
      [HOME],
      [],
      new Map(),
      () => new Promise(() => {}), // the events fetch never resolves
    );

    expect(await screen.findByText("Cover Groceries")).toBeInTheDocument();
    expect(document.querySelector(".time")).not.toBeNull(); // still mounted, same size, just no marks yet
    expect(document.querySelector(".time svg .t-stem")).toBeNull();
  });

  it("shows the 'To do' list even when the events fetch fails outright, just without overdue entries", async () => {
    renderScreen(
      budgetMonth({ categories: [category({ cashOverspending: 5_000 })] }),
      [HOME],
      [],
      new Map(),
      () => Promise.reject(new Error("network")),
    );

    expect(await screen.findByText("Cover Groceries")).toBeInTheDocument();
  });

  it("hides the timeline on a phone (a compact one of its own is #331's job), but keeps the 'To do' list", async () => {
    setWidth(390);
    renderScreen(budgetMonth({ categories: [category({ cashOverspending: 5_000 })] }), [HOME]);
    await screen.findByText("Cover Groceries");

    expect(document.querySelector(".time")).toBeNull();
    expect(document.querySelector(".todo")).not.toBeNull();
  });

  it("says there is nothing to fix when the 'To do' list is empty", async () => {
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");

    expect(await screen.findByText("Nothing to fix this month.")).toBeInTheDocument();
  });

  it("shows a credit card's own uncovered debt and a target still missing money", async () => {
    const goalsByCategory = new Map<string, GoalProgress>([
      [
        "c1",
        {
          goal: { id: "g1", workspaceId: "ws-1", categoryId: "c1", kind: "monthly", amountCents: 6_000, dueMonth: null, every: null, createdAt: "", updatedAt: "" },
          asks: 6_000,
          missing: 1_000,
          progress: 0.83,
        },
      ],
    ]);
    renderScreen(
      budgetMonth({ categories: [category({})], paymentCategories: [category({ categoryId: "visa", name: "Visa", uncovered: 12_000 })] }),
      [HOME],
      [],
      goalsByCategory,
    );
    await screen.findByText("Groceries");

    expect(await screen.findByText("Debt to cover: Visa")).toBeInTheDocument();
    expect(screen.getByText("Fund the Groceries target")).toBeInTheDocument();
  });
});
