import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
import type { Account } from "../accounts/api.ts";
import * as budgetApi from "../budget/api.ts";
import * as categoriesApi from "../categories/api.ts";
import type { Category } from "../categories/api.ts";
import * as reconciliationApi from "../reconciliation/api.ts";
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

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

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

function renderScreen(transactions: Transaction[], events: readonly budgetApi.MonthEvent[] = []) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
  vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
  vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue(transactions);
  vi.spyOn(budgetApi, "getBudgetMonthEvents").mockResolvedValue(events);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking"]}>
      <Routes>
        <Route path="/:workspaceId/accounts/:accountId" element={<AccountRegisterScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AccountRegisterScreen (#54, #333)", () => {
  afterEach(() => {
    setWidth(ORIGINAL_WIDTH);
    vi.useRealTimers();
  });

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

  it("shows the account header and balances, the big balance in the display face", async () => {
    renderScreen([
      transaction({ id: "t1", status: "cleared", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }] }),
      transaction({ id: "t2", status: "pending", occurredAt: "2026-09-16T00:00:00.000Z", budgetDate: "2026-09-16", splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -300, memo: null }] }),
    ]);

    expect(await screen.findByRole("heading", { name: "Checking" })).toBeInTheDocument();
    expect(screen.getByText("On-budget account", { exact: false })).toBeInTheDocument();
    const accBal = document.querySelector(".acc-bal")!;
    expect(accBal.querySelector(".big")).toHaveTextContent("-€15.00"); // total balance
    expect(accBal.textContent).toContain("-€3.00"); // pending
  });

  it("shows a short date, never the raw ISO one, in the desktop table", async () => {
    renderScreen([transaction({ budgetDate: "2026-09-15" })]);
    await screen.findByText("Supermarket");

    expect(screen.getByText("Sep 15")).toBeInTheDocument();
    expect(screen.queryByText("2026-09-15")).not.toBeInTheDocument();
  });

  it("shows amounts in the desktop table's own cells without a repeated currency symbol", async () => {
    renderScreen([transaction({ splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }] })]);
    const row = (await screen.findByText("Supermarket")).closest("tr")!;

    expect(within(row).getByText("12.00")).toBeInTheDocument(); // outflow cell
    expect(within(row).queryByText("€12.00")).not.toBeInTheDocument();
    expect(within(row).queryByText("-€12.00")).not.toBeInTheDocument();
  });

  it("lists transactions newest first with a running balance", async () => {
    renderScreen([
      transaction({ id: "t1", occurredAt: "2026-09-10T00:00:00.000Z", budgetDate: "2026-09-10", payee: "First", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1000, memo: null }] }),
      transaction({ id: "t2", occurredAt: "2026-09-20T00:00:00.000Z", budgetDate: "2026-09-20", payee: "Second", splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -500, memo: null }] }),
    ]);

    const rows = await screen.findAllByRole("row");
    // rows[0] is the header row; rows[1] should be the newest transaction ("Second").
    expect(rows[1]).toHaveTextContent("Second");
    expect(rows[1]).toHaveTextContent("15.00"); // running balance after both
    expect(rows[2]).toHaveTextContent("First");
    expect(rows[2]).toHaveTextContent("10.00");
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

    fireEvent.click(screen.getByText("Supermarket"));
    expect(await screen.findByText(/reconciled and locked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("unlocks a reconciled transaction from its read-only panel (#60)", async () => {
    renderScreen([transaction({ id: "t1", status: "reconciled", payee: "Supermarket" })]);
    await screen.findByText("Supermarket");
    const unlock = vi.spyOn(reconciliationApi, "unlockReconciliation").mockResolvedValue(undefined);

    fireEvent.click(screen.getByText("Supermarket"));
    await screen.findByText(/reconciled and locked/);
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(unlock).toHaveBeenCalledWith("t", "ws-1", "t1"));
    await waitFor(() => expect(screen.queryByText(/reconciled and locked/)).not.toBeInTheDocument());
  });

  it("opens the edit form for a non-reconciled transaction", async () => {
    renderScreen([transaction({ id: "t1", status: "cleared", payee: "Supermarket" })]);
    await screen.findByText("Supermarket");

    fireEvent.click(screen.getByText("Supermarket"));
    expect(await screen.findByRole("heading", { name: "Edit transaction" })).toBeInTheDocument();
  });

  it("opens a blank form from 'New transaction'", async () => {
    renderScreen([]);
    await screen.findByText("No transactions match this filter.");

    fireEvent.click(screen.getByRole("button", { name: "New transaction" }));
    expect(await screen.findByRole("heading", { name: "New transaction" })).toBeInTheDocument();
  });

  describe("the phone list (usePhoneWidth true, a different tree, not just a CSS reflow)", () => {
    it("groups transactions by day, with a day header", async () => {
      setWidth(390);
      renderScreen([
        transaction({ id: "t1", budgetDate: "2026-09-10", payee: "First" }),
        transaction({ id: "t2", budgetDate: "2026-09-20", payee: "Second" }),
      ]);
      await screen.findByText("Second");

      expect(screen.getByText("Thursday, September 10")).toBeInTheDocument();
      expect(screen.getByText("Sunday, September 20")).toBeInTheDocument();
    });

    it("picks 'Today' in the workspace's own time zone, not the browser's or plain UTC (#326)", async () => {
      // 23:30 UTC on the 9th is already the 10th in Rome (CEST, UTC+2) — this workspace's own "today".
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-09T23:30:00.000Z"));
      setWidth(390);
      renderScreen([transaction({ id: "t1", budgetDate: "2026-09-10", payee: "Supermarket" })]);
      await screen.findByText("Supermarket");

      expect(screen.getByText("Today")).toBeInTheDocument();
      expect(screen.queryByText("Thursday, September 10")).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("shows the payee above, 'category · memo' below, and the amount with its currency symbol", async () => {
      setWidth(390);
      renderScreen([transaction({ payee: "Supermarket", memo: "Weekly shop", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }] })]);
      await screen.findByText("Supermarket");

      expect(screen.getByText("Groceries · Weekly shop")).toBeInTheDocument();
      expect(document.querySelector(".ph-tx .amt")).toHaveTextContent("-€12.00");
    });

    it("has its own clickable, accessibly labelled status control", async () => {
      setWidth(390);
      renderScreen([transaction({ status: "pending" })]);
      await screen.findByText("Supermarket");

      expect(screen.getByRole("button", { name: /change status/ })).toBeInTheDocument();
    });

    it("shows no raw table, even though the data is identical", async () => {
      setWidth(390);
      renderScreen([transaction({})]);
      await screen.findByText("Supermarket");

      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("shows a short, un-truncated search placeholder instead of the desktop's longer one (#349)", async () => {
      setWidth(390);
      renderScreen([transaction({})]);
      await screen.findByText("Supermarket");

      expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Search payee, category, memo")).not.toBeInTheDocument();
    });

    it("shows no timeline, and the 'To do' list capped to two items, directly under the balance (#337)", async () => {
      setWidth(390);
      renderScreen(
        [transaction({ status: "pending" })],
        [
          { date: "2026-09-01", amountCents: -4_500, payee: "Internet provider", categoryId: null, kind: "scheduled", scheduledTransactionId: "s1" },
          { date: "2026-09-20", amountCents: -85_000, payee: "Mortgage lender", categoryId: null, kind: "scheduled", scheduledTransactionId: "s2" },
        ],
      );
      await screen.findByText("Supermarket");

      expect(document.querySelector(".time")).toBeNull();
      expect(document.querySelectorAll(".todo-i")).toHaveLength(2);
      expect(screen.getByText("+1 more")).toBeInTheDocument();
    });
  });

  describe("the timeline and 'To do' list (#337)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
    });

    it("shows the projected balance at month end: today's balance plus the not-yet-recorded scheduled items", async () => {
      renderScreen(
        [transaction({ splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }] })], // balance: -12.00
        [{ date: "2026-09-20", amountCents: -4_500, payee: "Internet provider", categoryId: null, kind: "scheduled", scheduledTransactionId: "s1" }],
      );
      await screen.findByText("Supermarket");

      expect(screen.getByText("Projected at month end")).toBeInTheDocument();
      expect(screen.getByText("-€57.00")).toBeInTheDocument();
    });

    it("shows the timeline, fed this account's own events", async () => {
      renderScreen([transaction({})], [{ date: "2026-09-20", amountCents: -4_500, payee: "Internet provider", categoryId: null, kind: "scheduled", scheduledTransactionId: "s1" }]);
      await screen.findByText("Supermarket");

      expect(document.querySelector(".time")).not.toBeNull();
    });

    it("shows Record for an overdue scheduled transaction, and calls the record endpoint on click", async () => {
      const record = vi.spyOn(budgetApi, "recordScheduledTransaction").mockResolvedValue(undefined as never);
      renderScreen([transaction({})], [{ date: "2026-09-01", amountCents: -4_500, payee: "Internet provider", categoryId: null, kind: "scheduled", scheduledTransactionId: "s1" }]);
      await screen.findByText("Supermarket");

      fireEvent.click(screen.getByRole("button", { name: /Record Internet provider/ }));
      await waitFor(() => expect(record).toHaveBeenCalledWith("t", "ws-1", "s1"));
    });

    it("shows Mark for a pending transaction, and marks it cleared on click", async () => {
      const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue(undefined as never);
      renderScreen([transaction({ id: "t1", status: "pending", payee: "Streaming service" })]);
      await screen.findByText("Streaming service");

      fireEvent.click(screen.getByRole("button", { name: /Mark Streaming service/ }));
      await waitFor(() => expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t1", { status: "cleared" }));
    });

    it("shows Reconcile once something is cleared", async () => {
      renderScreen([transaction({ status: "cleared" })]);
      await screen.findByText("Supermarket");

      expect(screen.getByText("Reconcile the account")).toBeInTheDocument();
    });

    it("folds the timeline and 'To do' list away entirely while a side sheet is open", async () => {
      renderScreen([transaction({ status: "cleared" })]);
      await screen.findByText("Supermarket");
      expect(document.querySelector(".time")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "New transaction" }));
      expect(document.querySelector(".time")).toBeNull();
      expect(document.querySelector(".todo")).toBeNull();
    });
  });
});
