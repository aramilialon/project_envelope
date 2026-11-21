import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../apiFetch.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as transactionsApi from "../transactions/api.ts";
import type { Transaction } from "../transactions/api.ts";
import { todayIsoIn } from "../workspaceDate.ts";
import * as workspacesApi from "../workspaces/api.ts";
import * as accountsApi from "./api.ts";
import type { Account } from "./api.ts";
import AccountsScreen from "./AccountsScreen.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const CHECKING: Account = {
  id: "a1",
  workspaceId: "ws-1",
  name: "Checking",
  type: "checking",
  currency: "EUR",
  onBudget: true,
  paymentCategoryId: null,
  closedAt: null,
  createdAt: "2026-01-01",
};

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

afterEach(() => {
  setWidth(ORIGINAL_WIDTH);
});

function renderScreen(accounts: Account[], transactions: Transaction[] = []) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome", taxCountry: null },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue(accounts);
  vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue(transactions);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/accounts"]}>
      <Routes>
        <Route path="/:workspaceId/accounts" element={<AccountsScreen />} />
        <Route path="/:workspaceId/accounts/:accountId" element={<p>Landed on the register</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AccountsScreen (#51, #323)", () => {
  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise(() => {}));
    vi.spyOn(accountsApi, "listAccounts").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts"]}>
        <Routes>
          <Route path="/:workspaceId/accounts" element={<AccountsScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading your accounts…");
  });

  it("says how long to wait while a load over the API's rate limit is retried, then shows the accounts (#683)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      useAuth.mockReturnValue({ user: { access_token: "t" } });
      vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([]);
      vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue([]);
      vi.spyOn(accountsApi, "listAccounts")
        .mockRejectedValueOnce(new ApiError("GET failed: 429", 429, "too_many_requests", { retryAfterSeconds: 20 }))
        .mockResolvedValueOnce([CHECKING]);
      renderWithIntl(
        <MemoryRouter initialEntries={["/ws-1/accounts"]}>
          <Routes>
            <Route path="/:workspaceId/accounts" element={<AccountsScreen />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests in a short time. Try again in 20 seconds.");
      expect(screen.queryByText("We could not load your accounts.")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect((await screen.findAllByText("Checking")).length).toBeGreaterThan(0);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error state", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([]);
    vi.spyOn(accountsApi, "listAccounts").mockRejectedValue(new Error("network"));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts"]}>
        <Routes>
          <Route path="/:workspaceId/accounts" element={<AccountsScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your accounts.");
  });

  it("shows an empty message when there are no accounts", async () => {
    renderScreen([]);
    expect(await screen.findByText("No accounts yet: add one below.")).toBeInTheDocument();
  });

  it("lists open accounts with their type and on/off-budget status", async () => {
    renderScreen([{ ...CHECKING, name: "Everyday" }, { ...CHECKING, id: "a2", name: "Mortgage", onBudget: false }]);

    expect(await screen.findByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("On budget")).toBeInTheDocument();
    expect(screen.getByText("Mortgage")).toBeInTheDocument();
    expect(screen.getByText("Off budget")).toBeInTheDocument();
  });

  it("lists a closed account separately, with no close button or link", async () => {
    renderScreen([{ ...CHECKING, id: "a2", name: "Old account", closedAt: "2026-02-01" }]);

    expect(await screen.findByText("Closed")).toBeInTheDocument();
    expect(screen.getByText("Old account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Old account" })).not.toBeInTheDocument();
  });

  it("closes an open account and refreshes the list", async () => {
    const closeAccount = vi.spyOn(accountsApi, "closeAccount").mockResolvedValue({ ...CHECKING, closedAt: "2026-03-01" });
    renderScreen([CHECKING]);
    await screen.findByRole("button", { name: "Checking" });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(closeAccount).toHaveBeenCalledWith("t", "ws-1", "a1"));
  });

  it("opens an open account's own register", async () => {
    renderScreen([CHECKING]);
    await screen.findByRole("button", { name: "Checking" });

    fireEvent.click(screen.getByRole("button", { name: "Checking" }));
    expect(await screen.findByText("Landed on the register")).toBeInTheDocument();
  });

  it("opens the add-account form from '+ Add account'", async () => {
    renderScreen([]);
    await screen.findByText("No accounts yet: add one below.");

    fireEvent.click(screen.getByRole("button", { name: "+ Add account" }));
    expect(await screen.findByRole("heading", { name: "Add account" })).toBeInTheDocument();
  });

  it("shows each account's own balance, summed from its own transactions", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome", taxCountry: null },
    ]);
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
    vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue([
      {
        id: "t1",
        workspaceId: "ws-1",
        accountId: "a1",
        occurredAt: "2026-09-01T00:00:00.000Z",
        budgetDate: "2026-09-01",
        payee: "Employer",
        memo: null,
        status: "cleared",
        transferId: null,
        transferAccountId: null,
        externalId: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        splits: [{ id: "s1", categoryId: null, amountCents: 150000, memo: null }],
      },
      {
        id: "t2",
        workspaceId: "ws-1",
        accountId: "a1",
        occurredAt: "2026-09-05T00:00:00.000Z",
        budgetDate: "2026-09-05",
        payee: "Supermarket",
        memo: null,
        status: "cleared",
        transferId: null,
        transferAccountId: null,
        externalId: null,
        createdAt: "2026-09-05T00:00:00.000Z",
        splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -4000, memo: null }],
      },
    ]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts"]}>
        <Routes>
          <Route path="/:workspaceId/accounts" element={<AccountsScreen />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("€1,460.00")).toBeInTheDocument();
  });

  it("shows each balance as of today in the workspace's time zone, leaving later rows out (#702)", async () => {
    // 23:30 UTC on 30 November is already 1 December in Rome.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T23:30:00.000Z"));
    const row = (id: string, budgetDate: string, amountCents: number): Transaction => ({
      id,
      workspaceId: "ws-1",
      accountId: "a1",
      occurredAt: `${budgetDate}T09:00:00.000Z`,
      budgetDate,
      payee: null,
      memo: null,
      status: "cleared",
      transferId: null,
      transferAccountId: null,
      externalId: null,
      createdAt: `${budgetDate}T09:00:00.000Z`,
      splits: [{ id: `s-${id}`, categoryId: null, amountCents, memo: null }],
    });
    renderScreen([CHECKING], [row("t1", "2026-12-01", 50_000), row("t2", "2026-12-02", 70_000)]);

    try {
      expect(await screen.findByText("€500.00")).toBeInTheDocument();
      expect(screen.queryByText("€1,200.00")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows each balance in its account's own currency, not the workspace's (#652)", async () => {
    const US_BROKER: Account = { ...CHECKING, id: "a2", name: "US broker", type: "brokerage", currency: "USD", onBudget: false };
    renderScreen([CHECKING, US_BROKER]);
    vi.spyOn(transactionsApi, "listTransactionsForAccount").mockImplementation((_token, _workspaceId, accountId) =>
      Promise.resolve([
        {
          id: `t-${accountId}`,
          workspaceId: "ws-1",
          accountId,
          occurredAt: "2026-09-01T00:00:00.000Z",
          budgetDate: "2026-09-01",
          payee: null,
          memo: null,
          status: "cleared",
          transferId: null,
          transferAccountId: null,
          externalId: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          splits: [{ id: `s-${accountId}`, categoryId: null, amountCents: accountId === "a2" ? 300_000 : 150_000, memo: null }],
        },
      ]),
    );

    expect(await screen.findByText("$3,000.00")).toBeInTheDocument();
    expect(screen.getByText("€1,500.00")).toBeInTheDocument();
    expect(screen.queryByText("€3,000.00")).not.toBeInTheDocument();
  });

  it("shows a one-column phone layout below 600px, with each account's own balance", async () => {
    setWidth(390);
    renderScreen([{ ...CHECKING, name: "Everyday" }, { ...CHECKING, id: "a2", name: "Old account", closedAt: "2026-02-01" }]);

    const open = await screen.findByRole("button", { name: /Everyday/ });
    expect(open).toHaveTextContent("On budget");
    expect(screen.queryByRole("button", { name: "Old account" })).not.toBeInTheDocument();
    expect(screen.getByText("Old account").closest(".ph-acc")).toHaveClass("static");
  });

  it("closes an open account from its own separate 'Close' button on the phone layout", async () => {
    setWidth(390);
    const closeAccount = vi.spyOn(accountsApi, "closeAccount").mockResolvedValue({ ...CHECKING, closedAt: "2026-03-01" });
    renderScreen([CHECKING]);
    await screen.findByRole("button", { name: /Checking/ });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(closeAccount).toHaveBeenCalledWith("t", "ws-1", "a1"));
  });

  describe("an account the API refuses to close because it is not empty (#703, #729)", () => {
    const intro = "This account can't be closed yet. Right now:";

    it("names today's balance, in the account's own currency, under the account's row", async () => {
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(new accountsApi.AccountNotEmptyError({ balanceCents: -12_345 }));
      renderScreen([{ ...CHECKING, currency: "USD", onBudget: false }]);
      await screen.findByRole("button", { name: "Checking" });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(intro);
      expect(within(alert).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Its balance today is -$123.45."]);
      expect(alert.parentElement?.closest("li")).toHaveTextContent("Checking");
      expect(screen.queryByText("Closed")).not.toBeInTheDocument();
    });

    it("names the rows dated after today, with how many and the first one's date, even when today's balance is zero", async () => {
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(
        new accountsApi.AccountNotEmptyError({ laterRows: { count: 2, firstDate: "2030-03-01" } }),
      );
      renderScreen([CHECKING]);
      await screen.findByRole("button", { name: "Checking" });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      const items = within(await screen.findByRole("alert")).getAllByRole("listitem");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent(/^2 transactions are dated after today, the first on .*2030\.$/);
    });

    it("leaves out the year of a later row dated in the workspace's own year", async () => {
      const thisYear = todayIsoIn("Europe/Rome").slice(0, 4);
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(
        new accountsApi.AccountNotEmptyError({ laterRows: { count: 1, firstDate: `${thisYear}-12-31` } }),
      );
      renderScreen([CHECKING]);
      await screen.findByRole("button", { name: "Checking" });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      const items = within(await screen.findByRole("alert")).getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual(["A transaction is dated after today, on Dec 31."]);
    });

    it("says only that the close failed when the refusal names no reason the screen knows of", async () => {
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(new accountsApi.AccountNotEmptyError({}));
      renderScreen([CHECKING]);
      await screen.findByRole("button", { name: "Checking" });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("We could not close this account.");
      expect(alert).not.toHaveTextContent(intro);
      expect(within(alert).queryAllByRole("listitem")).toHaveLength(0);
    });

    it("says the account holds securities, and counts a brokerage account's later trades with its transactions", async () => {
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(
        new accountsApi.AccountNotEmptyError({ holdsPositions: true, laterRows: { count: 1, firstDate: "2030-04-01" } }),
      );
      renderScreen([{ ...CHECKING, type: "brokerage", onBudget: false }]);
      await screen.findByRole("button", { name: "Checking" });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      const items = within(await screen.findByRole("alert")).getAllByRole("listitem");
      expect(items[0]).toHaveTextContent(/^A transaction or trade is dated after today, on .*2030\.$/);
      expect(items[1]).toHaveTextContent("It holds securities today.");
    });

    it("names every reason at once on the phone layout, the scheduled transactions included", async () => {
      setWidth(390);
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(
        new accountsApi.AccountNotEmptyError({ balanceCents: 50_000, holdsPositions: true, scheduled: { count: 3 } }),
      );
      renderScreen([{ ...CHECKING, type: "brokerage", onBudget: false }]);
      await screen.findByRole("button", { name: /Checking/ });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      const items = within(await screen.findByRole("alert")).getAllByRole("listitem").map((item) => item.textContent);
      expect(items).toEqual(["Its balance today is €500.00.", "It holds securities today.", "3 scheduled transactions use it."]);
    });

    it("keeps the message on the phone inside the account's own row, above its divider", async () => {
      setWidth(390);
      vi.spyOn(accountsApi, "closeAccount").mockRejectedValue(new accountsApi.AccountNotEmptyError({ balanceCents: 100 }));
      renderScreen([{ ...CHECKING, name: "Everyday" }, { ...CHECKING, id: "a2", name: "Holidays" }]);
      await screen.findByRole("button", { name: /Everyday/ });

      fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);

      const row = (await screen.findByRole("alert")).closest(".ph-acc");
      expect(row).toHaveTextContent("Everyday");
      expect(row).not.toHaveTextContent("Holidays");
    });

    it("clears the message on the next attempt, and says so plainly when closing fails for another reason", async () => {
      vi.spyOn(accountsApi, "closeAccount")
        .mockRejectedValueOnce(new accountsApi.AccountNotEmptyError({ balanceCents: 100 }))
        .mockRejectedValueOnce(new ApiError("PATCH failed: 500", 500, "internal_error", {}));
      renderScreen([CHECKING]);
      await screen.findByRole("button", { name: "Checking" });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("€1.00");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("We could not close this account."));
    });

    it("keeps focus on Close while the request runs and after it is refused, ignoring a second press", async () => {
      let refuse: (error: unknown) => void = () => {};
      const closeAccount = vi.spyOn(accountsApi, "closeAccount").mockReturnValue(
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
      );
      renderScreen([CHECKING]);
      await screen.findByRole("button", { name: "Checking" });
      const button = screen.getByRole("button", { name: "Close" });
      button.focus();

      fireEvent.click(button);
      await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
      expect(button).not.toBeDisabled();
      expect(button).toHaveFocus();
      fireEvent.click(button);
      expect(closeAccount).toHaveBeenCalledTimes(1);

      await act(async () => refuse(new accountsApi.AccountNotEmptyError({ balanceCents: 100 })));
      await screen.findByRole("alert");
      expect(button).toHaveAttribute("aria-disabled", "false");
      expect(button).toHaveFocus();
    });
  });
});
