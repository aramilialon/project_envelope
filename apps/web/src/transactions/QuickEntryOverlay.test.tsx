import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
import type { Account } from "../accounts/api.ts";
import * as categoriesApi from "../categories/api.ts";
import type { CategoryGroup } from "../categories/api.ts";
import * as budgetApi from "../budget/api.ts";
import type { BudgetMonthCategory, BudgetMonthResponse } from "../budget/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "../workspaces/api.ts";
import * as transactionsApi from "./api.ts";
import type { Transaction } from "./api.ts";
import QuickEntryOverlay from "./QuickEntryOverlay.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const CHECKING: Account = {
  id: "acc-checking",
  workspaceId: "ws-1",
  name: "Checking",
  type: "checking",
  currency: "EUR",
  onBudget: true,
  paymentCategoryId: null,
  closedAt: null,
  createdAt: "2026-01-01",
};
const HOME: CategoryGroup = { id: "g1", workspaceId: "ws-1", name: "Home", sortOrder: 1, archived: false };

function category(overrides: Partial<BudgetMonthCategory>): BudgetMonthCategory {
  return {
    categoryId: "cat-groceries",
    name: "Groceries",
    groupId: "g1",
    groupName: "Home",
    sortOrder: 1,
    carriedOver: 0,
    assigned: 5000,
    activity: 0,
    available: 5000,
    creditOverspending: 0,
    cashOverspending: 0,
    reserved: 0,
    uncovered: 0,
    ...overrides,
  };
}

function budgetMonth(overrides: Partial<BudgetMonthResponse> = {}): BudgetMonthResponse {
  return {
    month: "2026-09",
    unassigned: 0,
    assignedInFuture: 0,
    overspentLastMonth: 0,
    creditOverspending: 0,
    reserved: 0,
    categories: [category({})],
    paymentCategories: [],
    ...overrides,
  };
}

function renderOverlay(options: { accounts?: Account[]; groups?: CategoryGroup[]; month?: BudgetMonthResponse } = {}) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "editor", baseCurrency: "EUR", timeZone: "UTC" },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue(options.accounts ?? [CHECKING]);
  vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue(options.groups ?? [HOME]);
  vi.spyOn(budgetApi, "getBudgetMonth").mockResolvedValue(options.month ?? budgetMonth());
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const rendered = renderWithIntl(<QuickEntryOverlay workspaceId="ws-1" onClose={onClose} onSaved={onSaved} />);
  return { ...rendered, onClose, onSaved };
}

async function waitForForm() {
  await screen.findByText("New expense");
}

describe("QuickEntryOverlay (#367)", () => {
  it("records an expense in three taps: amount, category, save", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    const { onSaved } = renderOverlay();
    await waitForForm();

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save €12.00" }));

    await waitFor(() =>
      expect(createTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", {
        occurredAt: expect.any(String),
        splits: [{ categoryId: "cat-groceries", amountCents: -1200 }],
      }),
    );
    expect(await screen.findByText("Expense saved")).toBeInTheDocument();
    expect(document.querySelector(".toast")).toHaveTextContent("€12.00 with Checking. Groceries now has €38.00 available.");
    // Tells `AppLayout.tsx` to refresh the screen behind the overlay (#367), a separate
    // `useBudgetMonth` instance from this component's own.
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("includes the payee when one is given", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    renderOverlay();
    await waitForForm();

    fireEvent.change(screen.getByLabelText("Where"), { target: { value: "Supermarket" } });
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save €5.00" }));

    await screen.findByText("Expense saved");
    expect(document.querySelector(".toast")).toHaveTextContent("€5.00 from Supermarket with Checking.");
  });

  it("flags the category as overspent when the expense exceeds what is available", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    renderOverlay({ month: budgetMonth({ categories: [category({ available: 1000 })] }) });
    await waitForForm();

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save €15.00" }));

    await screen.findByText("Expense saved");
    expect(document.querySelector(".toast")).toHaveTextContent("It is overspent.");
  });

  it("disables saving until an amount and a category are chosen", async () => {
    renderOverlay();
    await waitForForm();

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(screen.getByRole("button", { name: "Save €1.00" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    expect(screen.getByRole("button", { name: "Save €1.00" })).toBeEnabled();
  });

  it("lets the user record another expense from the saved confirmation", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    renderOverlay();
    await waitForForm();

    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save €3.00" }));
    await screen.findByText("Expense saved");

    fireEvent.click(screen.getByRole("button", { name: "Another expense" }));
    await waitForForm();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("closes from the saved confirmation", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    const { onClose } = renderOverlay();
    await waitForForm();

    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save €3.00" }));
    await screen.findByText("Expense saved");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Cancel and on the Escape key", async () => {
    const { onClose } = renderOverlay();
    await waitForForm();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("asks to add an account or a category first when there are none to pick from", async () => {
    renderOverlay({ accounts: [], groups: [] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Add an on-budget account and a category first.");
  });
});
