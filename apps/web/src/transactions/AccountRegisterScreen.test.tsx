import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
import type { Account } from "../accounts/api.ts";
import * as categoriesApi from "../categories/api.ts";
import type { Category } from "../categories/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "../workspaces/api.ts";
import * as transactionsApi from "./api.ts";
import type { Transaction } from "./api.ts";
import AccountRegisterScreen from "./AccountRegisterScreen.tsx";

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
const GROCERIES: Category = { id: "cat-groceries", workspaceId: "ws-1", groupId: "g1", name: "Groceries", sortOrder: 1, archived: false };

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: "t1",
    workspaceId: "ws-1",
    accountId: "acc-checking",
    occurredAt: "2026-09-15T00:00:00.000Z",
    budgetDate: "2026-09-15",
    payee: "Supermarket",
    memo: null,
    status: "cleared",
    transferId: null,
    externalId: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    ...overrides,
  };
}

function renderScreen(transactions: Transaction[]) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR" },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
  vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
  vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue(transactions);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking"]}>
      <Routes>
        <Route path="/:workspaceId/accounts/:accountId" element={<AccountRegisterScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AccountRegisterScreen (#54)", () => {
  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise(() => {}));
    vi.spyOn(accountsApi, "listAccounts").mockReturnValue(new Promise(() => {}));
    vi.spyOn(categoriesApi, "listCategories").mockReturnValue(new Promise(() => {}));
    vi.spyOn(transactionsApi, "listTransactionsForAccount").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking"]}>
        <Routes>
          <Route path="/:workspaceId/accounts/:accountId" element={<AccountRegisterScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading this account…");
  });

  it("shows the account header and balances", async () => {
    renderScreen([
      transaction({ id: "t1", status: "cleared", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }] }),
      transaction({ id: "t2", status: "pending", occurredAt: "2026-09-16T00:00:00.000Z", budgetDate: "2026-09-16", splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -300, memo: null }] }),
    ]);

    expect(await screen.findByRole("heading", { name: "Checking" })).toBeInTheDocument();
    expect(screen.getByText("On-budget account", { exact: false })).toBeInTheDocument();
    const bal = document.querySelector(".bal")!;
    expect(bal.querySelector(".main .n")).toHaveTextContent("-€15.00"); // total balance
    expect(bal.textContent).toContain("-€3.00"); // pending
  });

  it("lists transactions newest first with a running balance", async () => {
    renderScreen([
      transaction({ id: "t1", occurredAt: "2026-09-10T00:00:00.000Z", budgetDate: "2026-09-10", payee: "First", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1000, memo: null }] }),
      transaction({ id: "t2", occurredAt: "2026-09-20T00:00:00.000Z", budgetDate: "2026-09-20", payee: "Second", splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -500, memo: null }] }),
    ]);

    const rows = await screen.findAllByRole("row");
    // rows[0] is the header row; rows[1] should be the newest transaction ("Second").
    expect(rows[1]).toHaveTextContent("Second");
    expect(rows[1]).toHaveTextContent("-€15.00"); // running balance after both
    expect(rows[2]).toHaveTextContent("First");
    expect(rows[2]).toHaveTextContent("-€10.00");
  });

  it("filters by status with counts", async () => {
    renderScreen([
      transaction({ id: "t1", status: "cleared" }),
      transaction({ id: "t2", status: "pending" }),
    ]);
    await screen.findAllByText("Supermarket");

    fireEvent.click(screen.getByRole("button", { name: "Pending 1" }));
    expect(screen.getAllByText("Supermarket")).toHaveLength(1);
  });

  it("filters by search text", async () => {
    renderScreen([
      transaction({ id: "t1", payee: "Supermarket" }),
      transaction({ id: "t2", payee: "Pharmacy", splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -500, memo: null }] }),
    ]);
    await screen.findByText("Supermarket");

    fireEvent.change(screen.getByPlaceholderText("Search payee, category, memo"), { target: { value: "pharmacy" } });
    expect(screen.queryByText("Supermarket")).not.toBeInTheDocument();
    expect(screen.getByText("Pharmacy")).toBeInTheDocument();
  });

  it("toggles a pending transaction to cleared", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue(transaction({ status: "cleared" }));
    renderScreen([transaction({ id: "t1", status: "pending" })]);
    await screen.findByText("Supermarket");

    fireEvent.click(screen.getByRole("button", { name: /change status/ }));

    await waitFor(() => expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t1", { status: "cleared" }));
  });

  it("disables the status toggle for a reconciled transaction", async () => {
    renderScreen([transaction({ id: "t1", status: "reconciled" })]);
    await screen.findByText("Supermarket");

    expect(screen.getByRole("button", { name: "Reconciled" })).toBeDisabled();
  });

  it("opens a read-only panel for a reconciled transaction instead of the edit form", async () => {
    renderScreen([transaction({ id: "t1", status: "reconciled", payee: "Supermarket" })]);
    await screen.findByText("Supermarket");

    fireEvent.click(screen.getAllByText("Supermarket")[0]!);
    expect(await screen.findByText(/reconciled and locked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("opens the edit form for a non-reconciled transaction", async () => {
    renderScreen([transaction({ id: "t1", status: "cleared", payee: "Supermarket" })]);
    await screen.findByText("Supermarket");

    fireEvent.click(screen.getAllByText("Supermarket")[0]!);
    expect(await screen.findByRole("heading", { name: "Edit transaction" })).toBeInTheDocument();
  });

  it("opens a blank form from 'New transaction'", async () => {
    renderScreen([]);
    await screen.findByText("No transactions match this filter.");

    fireEvent.click(screen.getByRole("button", { name: "New transaction" }));
    expect(await screen.findByRole("heading", { name: "New transaction" })).toBeInTheDocument();
  });
});
