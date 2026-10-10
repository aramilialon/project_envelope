import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
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
  scheduledTransactions: readonly budgetApi.ScheduledTransaction[] = [],
  role: workspacesApi.WorkspaceRole = "owner",
) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role, baseCurrency: "EUR", timeZone: "UTC" },
  ]);
  vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue(groups);
  const getBudgetMonth = vi.spyOn(budgetApi, "getBudgetMonth").mockResolvedValue(month);
  vi.spyOn(budgetApi, "getBudgetMonthEvents").mockImplementation(eventsImpl ?? (() => Promise.resolve(events)));
  vi.spyOn(targetsApi, "getGoal").mockImplementation((_t, _w, categoryId) => Promise.resolve(goalsByCategory.get(categoryId)));
  vi.spyOn(budgetApi, "listScheduledTransactions").mockResolvedValue(scheduledTransactions);
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

  it("shows the workspace's own days of buffer in the band's facts row, rounded (#344)", async () => {
    vi.spyOn(budgetApi, "getDaysOfBuffer").mockResolvedValue({ asOf: "2026-09-15", daysOfBuffer: 37.6 });
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");
    expect(await screen.findByText("Days of buffer")).toBeInTheDocument();
    expect(screen.getByText("38")).toBeInTheDocument();
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

  it("shows a category's own reservation clock line, naming its scheduled item's payee and date (#217)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    renderScreen(
      budgetMonth({ categories: [category({ categoryId: "c1", carriedOver: 10_000, available: 1_000, reserved: 9_000 })] }),
      [HOME],
      [],
      new Map(),
      undefined,
      [
        {
          id: "sched-1",
          workspaceId: "ws-1",
          accountId: "acc-1",
          payee: "Boiler service",
          memo: null,
          nextDueDate: "2026-09-29",
          recurEvery: 1,
          recurUnit: "year",
          createdAt: "",
          updatedAt: "",
          splits: [{ categoryId: "c1", amountCents: 9_000, memo: null }],
        },
      ],
    );
    expect(await screen.findByText(/Boiler service, Sep 29/)).toBeInTheDocument();
    expect(screen.getByText(/€90\.00 reserved/)).toBeInTheDocument();
  });

  it("marks the reservation line 'To record' when its scheduled item is already overdue (#217)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    renderScreen(
      budgetMonth({ categories: [category({ categoryId: "c1", carriedOver: 10_000, available: 1_000, reserved: 9_000 })] }),
      [HOME],
      [],
      new Map(),
      undefined,
      [
        {
          id: "sched-1",
          workspaceId: "ws-1",
          accountId: "acc-1",
          payee: "Boiler service",
          memo: null,
          nextDueDate: "2026-09-05", // already past "today" (the 10th)
          recurEvery: 1,
          recurUnit: "year",
          createdAt: "",
          updatedAt: "",
          splits: [{ categoryId: "c1", amountCents: 9_000, memo: null }],
        },
      ],
    );
    expect(await screen.findByText("To record")).toBeInTheDocument();
  });

  it("shows what is missing, as a warning, when the category cannot cover its own reservation (#217)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    renderScreen(
      budgetMonth({ categories: [category({ categoryId: "c1", carriedOver: 2_000, available: -7_000, reserved: 9_000 })] }),
      [HOME],
      [],
      new Map(),
      undefined,
      [
        {
          id: "sched-1",
          workspaceId: "ws-1",
          accountId: "acc-1",
          payee: "Boiler service",
          memo: null,
          nextDueDate: "2026-09-29",
          recurEvery: 1,
          recurUnit: "year",
          createdAt: "",
          updatedAt: "",
          splits: [{ categoryId: "c1", amountCents: 9_000, memo: null }],
        },
      ],
    );
    const line = await screen.findByText(/€90\.00 reserved/);
    expect(line.closest(".res")).toHaveClass("need");
    expect(line.closest(".res")).toHaveTextContent("€70.00 missing");
  });

  it("never shows 'missing' for a reservation shortfall on an already cash-overspent category (#217)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    renderScreen(
      budgetMonth({
        categories: [category({ categoryId: "c1", carriedOver: 2_000, available: -7_000, reserved: 9_000, cashOverspending: 2_000 })],
      }),
      [HOME],
      [],
      new Map(),
      undefined,
      [
        {
          id: "sched-1",
          workspaceId: "ws-1",
          accountId: "acc-1",
          payee: "Boiler service",
          memo: null,
          nextDueDate: "2026-09-29",
          recurEvery: 1,
          recurUnit: "year",
          createdAt: "",
          updatedAt: "",
          splits: [{ categoryId: "c1", amountCents: 9_000, memo: null }],
        },
      ],
    );
    const line = await screen.findByText(/€90\.00 reserved/);
    expect(line.closest(".res")).not.toHaveClass("need");
    expect(line.closest(".res")).not.toHaveTextContent("missing");
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

  it("opens a card's own payment category row into its own detail, fully covered (#329)", async () => {
    renderScreen(
      budgetMonth({ categories: [], paymentCategories: [category({ categoryId: "pc1", name: "Visa payment", available: 50_000, uncovered: 0 })] }),
      [HOME],
    );
    await screen.findByText("Visa payment");

    fireEvent.click(screen.getByRole("button", { name: /Visa payment/ }));
    expect(await screen.findByText("Set aside to pay the card")).toBeInTheDocument();
    expect(screen.getByText(/fully covered/)).toBeInTheDocument();
    expect(screen.queryByText("To cover")).not.toBeInTheDocument();
  });

  it("opens a card's own payment category row with its own debt still to cover, and 'Move money here' opens the move-money form (#329)", async () => {
    renderScreen(
      budgetMonth({ categories: [], paymentCategories: [category({ categoryId: "pc1", name: "Visa payment", available: 50_000, uncovered: 7_000 })] }),
      [HOME],
    );
    await screen.findByText("Visa payment");

    fireEvent.click(screen.getByRole("button", { name: /Visa payment/ }));
    expect(await screen.findByText("To cover")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move money here" }));
    expect(await screen.findByLabelText("To")).toHaveValue("pc1");
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

  it("opens the Scheduled panel (#330)", async () => {
    vi.spyOn(budgetApi, "listScheduledTransactions").mockResolvedValue([]);
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([]);
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
    expect(await screen.findByRole("heading", { name: "Scheduled" })).toBeInTheDocument();
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

  it("shows a compact timeline on a phone instead of hiding it, and keeps the 'To do' list (#331)", async () => {
    setWidth(390);
    renderScreen(budgetMonth({ categories: [category({ cashOverspending: 5_000 })] }), [HOME]);
    await screen.findByText("Cover Groceries");

    expect(document.querySelector(".time.compact")).not.toBeNull();
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

  it("opens a category's own detail full screen on a phone, with a back link, replacing the whole list (#331)", async () => {
    setWidth(390);
    renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: 60_000 })] }), [HOME]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    expect(await screen.findByLabelText("Assigned this month")).toHaveValue("600.00");
    expect(screen.getByRole("button", { name: /Budget/ })).toBeInTheDocument();
    // The list itself is gone, not just covered — the whole screen is the detail now.
    expect(screen.queryByText("To do")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Budget/ }));
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByLabelText("Assigned this month")).not.toBeInTheDocument();
  });

  it("opens a card's own payment category detail full screen on a phone too", async () => {
    setWidth(390);
    renderScreen(
      budgetMonth({ categories: [], paymentCategories: [category({ categoryId: "pc1", name: "Visa payment", available: 50_000, uncovered: 7_000 })] }),
      [HOME],
    );
    await screen.findByText("Visa payment");

    // The row's own button, not the "Debt to cover: Visa payment" to-do item (also clickable on a
    // phone, and also matching this name) — anchored so it only matches the row's own content,
    // which starts with the category's bare name.
    fireEvent.click(screen.getByRole("button", { name: /^Visa payment/ }));
    expect(await screen.findByText("To cover")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Budget/ })).toBeInTheDocument();
  });

  it("opens a to-do item's own category detail on a phone (not yet interactive on the desktop)", async () => {
    setWidth(390);
    renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", cashOverspending: 5_000 })] }), [HOME]);
    await screen.findByText("Cover Groceries");

    fireEvent.click(screen.getByRole("button", { name: /Cover Groceries/ }));
    expect(await screen.findByLabelText("Assigned this month")).toBeInTheDocument();
  });

  it("opens the Targets panel from a to-do item needing several targets funded, on a phone", async () => {
    setWidth(390);
    const goalsByCategory = new Map<string, GoalProgress>([
      ["c1", { goal: { id: "g1", workspaceId: "ws-1", categoryId: "c1", kind: "monthly", amountCents: 6_000, dueMonth: null, every: null, createdAt: "", updatedAt: "" }, asks: 6_000, missing: 1_000, progress: 0.83 }],
      ["c2", { goal: { id: "g2", workspaceId: "ws-1", categoryId: "c2", kind: "monthly", amountCents: 3_000, dueMonth: null, every: null, createdAt: "", updatedAt: "" }, asks: 3_000, missing: 500, progress: 0.83 }],
    ]);
    renderScreen(
      budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries" }), category({ categoryId: "c2", name: "Fuel", groupId: "g1" })] }),
      [HOME],
      [],
      goalsByCategory,
    );
    await screen.findByText("Fund 2 targets");

    fireEvent.click(screen.getByRole("button", { name: /Fund 2 targets/ }));
    expect(await screen.findByRole("heading", { name: "Targets" })).toBeInTheDocument();
  });

  it("stays plain, informational text for a to-do item on the desktop (#326's own docblock)", async () => {
    renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", cashOverspending: 5_000 })] }), [HOME]);
    await screen.findByText("Cover Groceries");

    expect(screen.queryByRole("button", { name: /Cover Groceries/ })).not.toBeInTheDocument();
  });

  it("collapses a group by tapping its own name, not just the chevron (#331, design.md)", async () => {
    renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
    const name = await screen.findByText("Home");

    fireEvent.click(name);
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
  });

  describe("read_only role gating (#61)", () => {
    it("hides Assign, Targets, Quick assign and Scheduled for a read_only member", async () => {
      renderScreen(budgetMonth({ categories: [category({})] }), [HOME], [], new Map(), undefined, [], "read_only");
      await screen.findByText("Groceries");

      expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Targets" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Quick assign" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Scheduled" })).not.toBeInTheDocument();
    });

    it("opens a category's own row detail read-only, with no edit or 'Move money'", async () => {
      renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: 60_000 })] }), [HOME], [], new Map(), undefined, [], "read_only");
      await screen.findByText("Groceries");

      fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
      const input = await screen.findByLabelText("Assigned this month");
      expect(input).toHaveAttribute("readonly");
      expect(screen.queryByRole("button", { name: "Move money" })).not.toBeInTheDocument();
    });

    it("still lets an owner/editor use these actions (not hidden for everyone)", async () => {
      renderScreen(budgetMonth({ categories: [category({})] }), [HOME]);
      await screen.findByText("Groceries");

      expect(screen.getByRole("button", { name: "Assign" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Targets" })).toBeInTheDocument();
    });
  });

  describe("instant budget-problem toast (#61)", () => {
    it("shows a toast once an action turns up a new overspent category, computed from the already-fetched month", async () => {
      vi.spyOn(budgetApi, "createAssignments").mockResolvedValue(undefined);
      const { getBudgetMonth } = renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: 1_000, available: 1_000 })] }), [HOME]);
      await screen.findByText("Groceries");

      // The row detail's own commit always refetches; this is what the server would really
      // report back once the edit above pushed the category negative.
      getBudgetMonth.mockResolvedValueOnce(
        budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", assigned: -500, available: -500 })] }),
      );
      fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
      const input = await screen.findByLabelText("Assigned this month");
      input.focus();
      fireEvent.change(input, { target: { value: "-5.00" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByText("Groceries is negative by €5.00.")).toBeInTheDocument();
    });

    it("never toasts on the very first load, only once something actually changes afterward", async () => {
      renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", available: -500 })] }), [HOME]);
      await screen.findByText("Groceries");

      expect(screen.queryByText(/is negative by/)).not.toBeInTheDocument();
    });

    it("dismisses the toast on its own close button", async () => {
      vi.spyOn(budgetApi, "createAssignments").mockResolvedValue(undefined);
      const { getBudgetMonth } = renderScreen(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", available: 1_000 })] }), [HOME]);
      await screen.findByText("Groceries");

      getBudgetMonth.mockResolvedValueOnce(budgetMonth({ categories: [category({ categoryId: "c1", name: "Groceries", available: -500 })] }));
      fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
      const input = await screen.findByLabelText("Assigned this month");
      input.focus();
      fireEvent.change(input, { target: { value: "-5.00" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByText("Groceries is negative by €5.00.");

      fireEvent.click(screen.getByRole("button", { name: "Close this message" }));
      expect(screen.queryByText("Groceries is negative by €5.00.")).not.toBeInTheDocument();
    });
  });
});
