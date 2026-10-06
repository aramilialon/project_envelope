import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as transactionsApi from "../transactions/api.ts";
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

function renderScreen(accounts: Account[]) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue(accounts);
  vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue([]);
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
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
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

  it("shows a one-column phone layout below 600px, with each account's own balance", async () => {
    setWidth(390);
    renderScreen([{ ...CHECKING, name: "Everyday" }, { ...CHECKING, id: "a2", name: "Old account", closedAt: "2026-02-01" }]);

    const open = await screen.findByRole("button", { name: /Everyday/ });
    expect(open).toHaveTextContent("On budget");
    expect(screen.queryByRole("button", { name: "Old account" })).not.toBeInTheDocument();
    expect(screen.getByText("Old account").closest(".ph-acc")).toHaveClass("static");
  });
});
