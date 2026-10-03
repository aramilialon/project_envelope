import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
import type { Account } from "../accounts/api.ts";
import * as targetsApi from "../targets/api.ts";
import type { GoalProgress } from "../targets/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as budgetApi from "./api.ts";
import type { ScheduledTransaction } from "./api.ts";
import ScheduledPanel from "./ScheduledPanel.tsx";
import type { BudgetGroup, BudgetGroupCategory } from "./useBudgetMonth.ts";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function category(overrides: Partial<BudgetGroupCategory>): BudgetGroupCategory {
  return {
    categoryId: "rent",
    name: "Rent",
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
  { id: "g1", name: "Home", categories: [category({ categoryId: "rent", name: "Rent" }), category({ categoryId: "internet", name: "Internet" })] },
];

const ACCOUNT: Account = {
  id: "acc-1",
  workspaceId: "ws-1",
  name: "Checking",
  type: "checking",
  currency: "EUR",
  onBudget: true,
  paymentCategoryId: null,
  closedAt: null,
  createdAt: "2026-01-01",
};

function scheduledTransaction(overrides: Partial<ScheduledTransaction>): ScheduledTransaction {
  return {
    id: "sched-1",
    workspaceId: "ws-1",
    accountId: "acc-1",
    payee: "Landlord",
    memo: null,
    nextDueDate: "2026-09-05",
    recurEvery: 1,
    recurUnit: "month",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    splits: [{ categoryId: "rent", amountCents: 90_000, memo: null }],
    ...overrides,
  };
}

function renderPanel(scheduledTransactions: readonly ScheduledTransaction[], goalsByCategory: ReadonlyMap<string, GoalProgress> = new Map()) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([ACCOUNT]);
  vi.spyOn(budgetApi, "listScheduledTransactions").mockResolvedValue(scheduledTransactions);
  vi.spyOn(targetsApi, "getGoal").mockImplementation((_t, _w, categoryId) => Promise.resolve(goalsByCategory.get(categoryId)));
  const onClose = vi.fn();
  const onChanged = vi.fn();
  renderWithIntl(
    <ScheduledPanel workspaceId="ws-1" month="2026-09" groups={GROUPS} currency="EUR" timeZone="Europe/Rome" onClose={onClose} onChanged={onChanged} />,
  );
  return { onClose, onChanged };
}

function goalProgress(overrides: Partial<GoalProgress> = {}): GoalProgress {
  return {
    goal: { id: "g1", workspaceId: "ws-1", categoryId: "rent", kind: "monthly", amountCents: 90_000, dueMonth: null, every: null, createdAt: "", updatedAt: "" },
    asks: 90_000,
    missing: 0,
    progress: 1,
    ...overrides,
  };
}

describe("ScheduledPanel (#330)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("groups overdue items under 'To record', others under 'By the end of the month'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
    renderPanel([
      scheduledTransaction({ id: "late", nextDueDate: "2026-09-05", payee: "Landlord" }),
      scheduledTransaction({ id: "soon", nextDueDate: "2026-09-25", payee: "Gym" }),
    ]);

    await screen.findByText("Landlord");
    expect(screen.getByRole("heading", { name: "To record" })).toBeInTheDocument();
    expect(screen.getByText("Gym")).toBeInTheDocument();
  });

  it("'Record' creates the real transaction and refetches", async () => {
    const recordScheduledTransaction = vi
      .spyOn(budgetApi, "recordScheduledTransaction")
      .mockResolvedValue({ transaction: { id: "tx-1" }, scheduledTransaction: scheduledTransaction({ nextDueDate: "2026-10-05" }) });
    const { onChanged } = renderPanel([scheduledTransaction({ id: "sched-1", nextDueDate: "2026-09-05" })]);
    await screen.findByText("Landlord");

    fireEvent.click(screen.getAllByRole("button", { name: "Record" })[0]!);

    await waitFor(() => expect(recordScheduledTransaction).toHaveBeenCalledWith("t", "ws-1", "sched-1"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("'Skip' advances the due date without creating a transaction", async () => {
    const skipScheduledTransaction = vi
      .spyOn(budgetApi, "skipScheduledTransaction")
      .mockResolvedValue(scheduledTransaction({ nextDueDate: "2026-10-05" }));
    const { onChanged } = renderPanel([scheduledTransaction({ id: "sched-1", nextDueDate: "2026-09-05" })]);
    await screen.findByText("Landlord");

    fireEvent.click(screen.getAllByRole("button", { name: "Skip" })[0]!);

    await waitFor(() => expect(skipScheduledTransaction).toHaveBeenCalledWith("t", "ws-1", "sched-1"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("next month's preview shows 'within the target' when the target already asks enough", async () => {
    renderPanel(
      [scheduledTransaction({ nextDueDate: "2026-10-05", splits: [{ categoryId: "rent", amountCents: 90_000, memo: null }] })],
      new Map([["rent", goalProgress({ asks: 90_000 })]]),
    );
    expect(await screen.findByText("Within the target")).toBeInTheDocument();
  });

  it("next month's preview shows what is missing when the target asks less than scheduled", async () => {
    renderPanel(
      [scheduledTransaction({ nextDueDate: "2026-10-05", splits: [{ categoryId: "rent", amountCents: 90_000, memo: null }] })],
      new Map([["rent", goalProgress({ asks: 50_000 })]]),
    );
    expect(await screen.findByText("The target asks €500.00: €400.00 missing")).toBeInTheDocument();
  });

  it("next month's preview offers 'Use as target' for a monthly-recurring category with no target yet", async () => {
    renderPanel([scheduledTransaction({ nextDueDate: "2026-10-05", recurEvery: 1, recurUnit: "month" })]);
    expect(await screen.findByText("No target")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use as target" })).toBeInTheDocument();
  });

  it("'Use as target' sets a monthly target from the scheduled amount", async () => {
    const upsertGoal = vi.spyOn(targetsApi, "upsertGoal").mockResolvedValue({} as never);
    const { onChanged } = renderPanel([scheduledTransaction({ nextDueDate: "2026-10-05", recurEvery: 1, recurUnit: "month" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Use as target" }));

    await waitFor(() => expect(upsertGoal).toHaveBeenCalledWith("t", "ws-1", "rent", { kind: "monthly", amountCents: 90_000 }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("does not offer 'Use as target' for a non-monthly recurrence", async () => {
    renderPanel([scheduledTransaction({ nextDueDate: "2026-10-05", recurEvery: 2, recurUnit: "day" })]);
    await screen.findByText("No target");
    expect(screen.queryByRole("button", { name: "Use as target" })).not.toBeInTheDocument();
  });

  it("'+ New scheduled transaction' creates one and refetches", async () => {
    const createScheduledTransaction = vi.spyOn(budgetApi, "createScheduledTransaction").mockResolvedValue(scheduledTransaction({}));
    const { onChanged } = renderPanel([]);

    fireEvent.click(await screen.findByRole("button", { name: "+ New scheduled transaction" }));
    await screen.findByText("Checking"); // waits for the account select's own options to resolve
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Landlord" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "900.00" } });
    fireEvent.change(screen.getByLabelText("Next date"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createScheduledTransaction).toHaveBeenCalledWith("t", "ws-1", {
        accountId: "acc-1",
        payee: "Landlord",
        nextDueDate: "2026-10-01",
        recurEvery: 1,
        recurUnit: "month",
        categoryId: "rent",
        amountCents: 90_000,
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("'+ New scheduled transaction' offers 'Use it as this category's target' when the category has none yet, and setting one (#217)", async () => {
    const upsertGoal = vi.spyOn(targetsApi, "upsertGoal").mockResolvedValue({} as never);
    vi.spyOn(budgetApi, "createScheduledTransaction").mockResolvedValue(scheduledTransaction({}));
    renderPanel([]);

    fireEvent.click(await screen.findByRole("button", { name: "+ New scheduled transaction" }));
    await screen.findByText("Checking");
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Landlord" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "900.00" } });
    fireEvent.change(screen.getByLabelText("Next date"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByLabelText("Use it as this category's target"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(upsertGoal).toHaveBeenCalledWith("t", "ws-1", "rent", { kind: "monthly", amountCents: 90_000 }));
  });

  it("'+ New scheduled transaction' does not offer 'Use it as this category's target' when the category already has one", async () => {
    renderPanel([], new Map([["rent", goalProgress()]]));
    fireEvent.click(await screen.findByRole("button", { name: "+ New scheduled transaction" }));
    await screen.findByText("Checking");
    expect(screen.queryByLabelText("Use it as this category's target")).not.toBeInTheDocument();
  });

  it("'+ New scheduled transaction' does not offer 'Use it as this category's target' for a non-monthly recurrence", async () => {
    renderPanel([]);
    fireEvent.click(await screen.findByRole("button", { name: "+ New scheduled transaction" }));
    await screen.findByText("Checking");
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "day" } });
    expect(screen.queryByLabelText("Use it as this category's target")).not.toBeInTheDocument();
  });

  it("the '× Close' button calls onClose", async () => {
    const { onClose } = renderPanel([]);
    fireEvent.click(await screen.findByRole("button", { name: "× Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
