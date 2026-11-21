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
    transferAccountId: null,
    externalId: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    ...overrides,
  };
}

function renderScreen(transactions: Transaction[], events: readonly budgetApi.MonthEvent[] = [], accounts: readonly Account[] = [CHECKING], timeZone = "Europe/Rome") {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone, taxCountry: null },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([...accounts]);
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
  beforeEach(() => {
    // A fixed "today" after every sample row, so none of them is a "Later" row and their short
    // dates stay in the current year whatever the real date (#702); tests that need another day
    // set their own.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T10:00:00.000Z"));
  });

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

  describe("a transfer with an off-budget account (#599)", () => {
    const BROKER: Account = { ...CHECKING, id: "acc-broker", name: "Broker", type: "brokerage", onBudget: false };
    const SAVINGS: Account = { ...CHECKING, id: "acc-savings", name: "Savings" };

    it("names where money coming in came from and that it landed in Unassigned", async () => {
      renderScreen(
        [transaction({ payee: "Sale", transferId: "leg-out", transferAccountId: "acc-broker", splits: [{ id: "s1", categoryId: null, amountCents: 500_000, memo: null }] })],
        [],
        [CHECKING, BROKER],
      );
      const row = (await screen.findByText("Sale")).closest("tr")!;
      expect(within(row).getByText("Transfer · From Broker · Unassigned")).toBeInTheDocument();
    });

    it("names the category such money landed in instead, when it has one", async () => {
      renderScreen(
        [transaction({ payee: "Sale", transferId: "leg-out", transferAccountId: "acc-broker", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: 500_000, memo: null }] })],
        [],
        [CHECKING, BROKER],
      );
      const row = (await screen.findByText("Sale")).closest("tr")!;
      expect(within(row).getByText("Transfer · From Broker · Groceries")).toBeInTheDocument();
    });

    it("mirrors it for money going out to the off-budget account", async () => {
      renderScreen(
        [transaction({ payee: "Monthly", transferId: "leg-in", transferAccountId: "acc-broker", splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -50_000, memo: null }] })],
        [],
        [CHECKING, BROKER],
      );
      const row = (await screen.findByText("Monthly")).closest("tr")!;
      expect(within(row).getByText("Transfer · To Broker · Groceries")).toBeInTheDocument();
    });

    it("keeps a plain 'Transfer' between two on-budget accounts", async () => {
      renderScreen(
        [transaction({ payee: "Move", transferId: "leg-in", transferAccountId: "acc-savings", splits: [{ id: "s1", categoryId: null, amountCents: -1_000, memo: null }] })],
        [],
        [CHECKING, SAVINGS],
      );
      const row = (await screen.findByText("Move")).closest("tr")!;
      expect(within(row).getByText("Transfer")).toBeInTheDocument();
    });

    it("uses the same label on the phone, under the payee", async () => {
      setWidth(390);
      renderScreen(
        [transaction({ payee: "Sale", transferId: "leg-out", transferAccountId: "acc-broker", splits: [{ id: "s1", categoryId: null, amountCents: 500_000, memo: null }] })],
        [],
        [CHECKING, BROKER],
      );
      expect(await screen.findByText("Transfer · From Broker · Unassigned")).toBeInTheDocument();
    });
  });

  describe("an off-budget account in its own currency (#652)", () => {
    const US_BROKER: Account = { ...CHECKING, name: "US broker", type: "brokerage", currency: "USD", onBudget: false };
    const EU_BROKER: Account = { ...CHECKING, name: "Broker", type: "brokerage", onBudget: false };
    const cashLeg = (overrides: Partial<Transaction>) =>
      transaction({ payee: "Buy ETF", splits: [{ id: "s1", categoryId: null, amountCents: -100_000, memo: null }], ...overrides });

    it("shows its balances in the account's currency, not the workspace's", async () => {
      renderScreen(
        [
          cashLeg({ id: "t1", payee: "Deposit", status: "cleared", splits: [{ id: "s1", categoryId: null, amountCents: 500_000, memo: null }] }),
          cashLeg({ id: "t2", status: "pending", occurredAt: "2026-09-16T00:00:00.000Z", budgetDate: "2026-09-16" }),
        ],
        [],
        [US_BROKER],
      );

      const accBal = (await screen.findByRole("heading", { name: "US broker" })) && document.querySelector(".acc-bal")!;
      expect(accBal.querySelector(".big")).toHaveTextContent("$4,000.00");
      expect(accBal.textContent).toContain("$5,000.00"); // cleared
      expect(accBal.textContent).toContain("-$1,000.00"); // pending
      expect(accBal.textContent).not.toContain("€");
    });

    it("leaves the category cell empty, never 'Unassigned', a trade's cash leg included", async () => {
      renderScreen(
        [
          cashLeg({ id: "t1", payee: "Deposit", splits: [{ id: "s1", categoryId: null, amountCents: 500_000, memo: null }] }),
          cashLeg({ id: "t2", payee: "Buy ETF", tradeId: "trade-1" } as Partial<Transaction>),
        ],
        [],
        [EU_BROKER],
      );

      const deposit = (await screen.findByText("Deposit")).closest("tr")!;
      const buy = screen.getByText("Buy ETF").closest("tr")!;
      for (const row of [deposit, buy]) {
        const cell = row.querySelectorAll("td")[3]!;
        expect(cell).toHaveTextContent(/^$/);
        // No unnamed button left as an empty tab stop.
        expect(within(cell).queryByRole("button")).not.toBeInTheDocument();
      }
      expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
    });

    it("shows a zero-decimal currency's amounts and balances with no decimals", async () => {
      const yen: Account = { ...EU_BROKER, name: "Yen account", currency: "JPY" };
      renderScreen(
        [
          cashLeg({ id: "t1", payee: "Deposit", splits: [{ id: "s1", categoryId: null, amountCents: 50_000, memo: null }] }),
          cashLeg({ id: "t2", payee: "Bookshop", occurredAt: "2026-09-16T00:00:00.000Z", budgetDate: "2026-09-16", splits: [{ id: "s2", categoryId: null, amountCents: -5_000, memo: null }] }),
        ],
        [],
        [yen],
      );

      const row = (await screen.findByText("Bookshop")).closest("tr")!;
      const cells = row.querySelectorAll("td");
      expect(cells[4]).toHaveTextContent(/^5,000$/);
      expect(cells[6]).toHaveTextContent(/^45,000$/);
      expect(document.querySelector(".acc-bal .big")).toHaveTextContent("¥45,000");
      expect(document.querySelector(".acc-bal .big")!.textContent).not.toContain(".");
    });

    it("keeps naming a transfer in an off-budget register", async () => {
      renderScreen(
        [cashLeg({ payee: "From checking", transferId: "leg-out", transferAccountId: "acc-other", splits: [{ id: "s1", categoryId: null, amountCents: 50_000, memo: null }] })],
        [],
        [EU_BROKER, { ...CHECKING, id: "acc-other", name: "Checking" }],
      );

      const row = (await screen.findByText("From checking")).closest("tr")!;
      expect(within(row).getByText("Transfer")).toBeInTheDocument();
    });

    it("shows no 'Unassigned' on the phone either, only the memo under the payee", async () => {
      setWidth(390);
      renderScreen([cashLeg({ memo: "Monthly plan" })], [], [EU_BROKER]);

      // Exactly the memo: no empty category before it, no " · " left over.
      expect((await screen.findByText("Monthly plan")).tagName).toBe("SMALL");
      expect(screen.queryByText(/Unassigned/)).not.toBeInTheDocument();
    });

    it("finds no 'Unassigned' when searching an off-budget register", async () => {
      renderScreen([cashLeg({})], [], [EU_BROKER]);
      await screen.findByText("Buy ETF");

      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unassigned" } });
      expect(screen.queryByText("Buy ETF")).not.toBeInTheDocument();
    });
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

  it("closes the 'New transaction' form when its own button is pressed again (#410)", async () => {
    renderScreen([]);
    await screen.findByText("No transactions match this filter.");

    fireEvent.click(screen.getByRole("button", { name: "New transaction" }));
    expect(await screen.findByRole("heading", { name: "New transaction" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New transaction" }));
    expect(screen.queryByRole("heading", { name: "New transaction" })).not.toBeInTheDocument();
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

  describe("balances as of today, and the rows after it under 'Later' (#702)", () => {
    // Today is 21 November 2026 in Rome.
    beforeEach(() => {
      vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
    });

    function row(id: string, budgetDate: string, payee: string, amountCents: number, status: Transaction["status"] = "cleared"): Transaction {
      return transaction({
        id,
        occurredAt: `${budgetDate}T10:00:00.000Z`,
        budgetDate,
        payee,
        status,
        splits: [{ id: `s-${id}`, categoryId: amountCents > 0 ? null : "cat-groceries", amountCents, memo: null }],
      });
    }

    const ROWS = [
      row("t1", "2026-11-02", "Salary", 200_000),
      row("t2", "2026-11-20", "Supermarket", -8_000, "pending"),
      row("t3", "2026-11-28", "Gym", -4_000, "pending"),
      row("t4", "2026-12-05", "Bonus", 50_000, "pending"),
      row("t5", "2028-03-03", "Sale", 300_000),
    ];
    const SCHEDULED: budgetApi.MonthEvent[] = [
      { date: "2026-11-15", amountCents: -4_500, payee: "Internet provider", categoryId: "cat-groceries", kind: "scheduled", scheduledTransactionId: "s1" },
      { date: "2026-11-27", amountCents: -10_000, payee: "Boiler service", categoryId: "cat-groceries", kind: "scheduled", scheduledTransactionId: "s2" },
    ];

    it("counts only the rows up to today in the balance, cleared and pending", async () => {
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      const facts = document.querySelector(".acc-bal")!;
      expect(facts.querySelector(".big")).toHaveTextContent("€1,920.00");
      expect(facts.textContent).toContain("Cleared €2,000.00");
      expect(facts.textContent).toContain("Pending -€80.00");
    });

    it("projects today's balance, the rows after today up to the month end and the month's scheduled items not recorded yet", async () => {
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      // 1,920.00 - 40.00 (Gym, 28 Nov) - 45.00 (overdue) - 100.00 (due 27 Nov); December and 2028 count in none.
      expect(document.querySelector(".acc-bal")!.textContent).toContain("Projected at month end €1,735.00");
    });

    it("lists every row dated after today under 'Later', at the top, above today's rows", async () => {
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      const groups = screen.getAllByRole("rowgroup");
      // [0] is the header; [1] the "Later" rows; [2] the rows up to today.
      const later = groups[1]!;
      // The heading and its note read as two words apart, not "LaterDated…" (#702).
      expect(within(later).getByRole("rowheader")).toHaveAccessibleName("Later Dated after today: not in today's balance.");
      expect(within(later).getByText("Sale")).toBeInTheDocument();
      expect(within(later).getByText("Bonus")).toBeInTheDocument();
      expect(within(later).getByText("Gym")).toBeInTheDocument();
      expect(within(groups[2]!).queryByText("Gym")).not.toBeInTheDocument();
      expect(within(groups[2]!).getByText("Supermarket")).toBeInTheDocument();
    });

    it("runs the balance from today's: each 'Later' row shows the balance it leads to", async () => {
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      expect(screen.getByText("Supermarket").closest("tr")).toHaveTextContent("1,920.00");
      expect(screen.getByText("Gym").closest("tr")).toHaveTextContent("1,880.00");
      expect(screen.getByText("Bonus").closest("tr")).toHaveTextContent("2,380.00");
      expect(screen.getByText("Sale").closest("tr")).toHaveTextContent("5,380.00");
    });

    it("never lists a row after today as still awaiting the bank", async () => {
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      expect(screen.getByRole("button", { name: /Mark Supermarket/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Mark Gym/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Mark Bonus/ })).not.toBeInTheDocument();
    });

    it("shows the year in a short date of another year", async () => {
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      expect(screen.getByText("Mar 3, 2028")).toBeInTheDocument();
      expect(screen.getByText("Dec 5")).toBeInTheDocument();
    });

    it("shows no 'Later' section when nothing is dated after today", async () => {
      renderScreen([ROWS[0]!, ROWS[1]!]);
      await screen.findByText("Salary");

      expect(screen.queryByText("Later")).not.toBeInTheDocument();
    });

    it("draws today at the workspace's midnight, not the browser's or UTC's", async () => {
      // 23:30 UTC on 30 November is already 1 December in Rome: a row dated 1 December is today's.
      vi.setSystemTime(new Date("2026-11-30T23:30:00.000Z"));
      renderScreen([row("t1", "2026-11-30", "Salary", 200_000), row("t2", "2026-12-01", "Rent", -50_000)]);
      await screen.findByText("Rent");

      expect(document.querySelector(".acc-bal .big")).toHaveTextContent("€1,500.00");
      expect(screen.queryByText("Later")).not.toBeInTheDocument();
    });

    it("reads the current year in the workspace's time zone, not the browser's, around New Year", async () => {
      // 10:30 UTC on 31 December is already 1 January 2027 at UTC+14, while a browser anywhere from
      // UTC-12 to UTC+13 is still in 2026: the workspace's year decides which dates show a year.
      vi.setSystemTime(new Date("2026-12-31T10:30:00.000Z"));
      renderScreen(
        [row("t1", "2026-12-30", "Supermarket", -8_000, "pending"), row("t2", "2027-01-01", "Bakery", -500)],
        [],
        [CHECKING],
        "Pacific/Kiritimati",
      );
      await screen.findByText("Bakery");
      const bakery = screen.getByText("Bakery").closest("tr")!;
      await waitFor(() => expect(within(bakery).getByRole("button", { name: "Jan 1" })).toBeInTheDocument());

      const supermarket = screen.getByText("Supermarket").closest("tr")!;
      expect(within(supermarket).getByRole("button", { name: "Dec 30, 2026" })).toBeInTheDocument();
      // The "To do" list's dates read the same year.
      expect(screen.getByRole("button", { name: /Mark Supermarket/ })).toHaveTextContent("Dec 30, 2026, still awaiting the bank");
    });

    it("puts the 'Later' heading above the later days on the phone too", async () => {
      setWidth(390);
      renderScreen(ROWS, SCHEDULED);
      await screen.findByText("Salary");

      const heading = screen.getByRole("heading", { name: "Later" });
      // The note sits right after the heading, outside it.
      expect(heading.nextElementSibling).toHaveTextContent("Dated after today: not in today's balance.");
      expect(heading.nextElementSibling!.tagName).toBe("P");
      const dayHeaders = [...document.querySelectorAll(".ph-day")].map((d) => d.textContent);
      expect(dayHeaders[0]).toBe("Friday, March 3, 2028");
      // The later days come first, then today's and the earlier ones.
      expect(dayHeaders.indexOf("Saturday, November 28")).toBeLessThan(dayHeaders.indexOf("Friday, November 20"));
      expect(heading.compareDocumentPosition(screen.getByText("Supermarket")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    it("labels the timeline's axis in the account's own currency (#652)", async () => {
      const usBroker: Account = { ...CHECKING, name: "US broker", type: "brokerage", currency: "USD", onBudget: false };
      renderScreen(
        [transaction({ splits: [{ id: "s1", categoryId: null, amountCents: 300_000, memo: null }] })],
        [{ date: "2026-09-10", amountCents: 300_000, payee: "Supermarket", categoryId: null, kind: "recorded" }],
        [usBroker],
      );
      await screen.findByText("Supermarket");

      const labels = [...document.querySelectorAll(".t-grid-l")].map((label) => label.textContent ?? "");
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((label) => label.includes("$") && !label.includes("€"))).toBe(true);
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

    it("offers a plain, always-available 'Reconcile' toolbar link, not a 'To do' nag (#404)", async () => {
      renderScreen([transaction({ status: "cleared" })]);
      await screen.findByText("Supermarket");

      expect(screen.queryByText("Reconcile the account")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Reconcile" })).toHaveAttribute("href", "/ws-1/accounts/acc-checking/reconcile");
    });

    it("keeps the 'Reconcile' link even with nothing cleared yet (#404)", async () => {
      renderScreen([transaction({ status: "pending" })]);
      await screen.findByText("Supermarket");

      expect(screen.getByRole("link", { name: "Reconcile" })).toBeInTheDocument();
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
