import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as accountsApi from "./api.ts";
import type { Account } from "./api.ts";
import AccountsScreen from "./AccountsScreen.tsx";
import type { AccountsState } from "./useAccounts.ts";

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

function renderScreen(state: AccountsState, refetch = vi.fn()) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/accounts"]}>
      <Routes>
        <Route path="/:workspaceId" element={<Outlet context={{ ...state, refetch }} />}>
          <Route path="accounts" element={<AccountsScreen />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AccountsScreen (#51)", () => {
  it("shows a loading state", () => {
    renderScreen({ status: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading your accounts…");
  });

  it("shows an error state", () => {
    renderScreen({ status: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load your accounts.");
  });

  it("shows an empty message when there are no accounts", () => {
    renderScreen({ status: "ok", accounts: [] });
    expect(screen.getByText("No accounts yet: add one from the sidebar.")).toBeInTheDocument();
  });

  it("lists open accounts with their type and on/off-budget status", () => {
    renderScreen({
      status: "ok",
      accounts: [{ ...CHECKING, name: "Everyday" }, { ...CHECKING, id: "a2", name: "Mortgage", onBudget: false }],
    });

    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("On budget")).toBeInTheDocument();
    expect(screen.getByText("Mortgage")).toBeInTheDocument();
    expect(screen.getByText("Off budget")).toBeInTheDocument();
  });

  it("lists a closed account separately, with no close button", () => {
    renderScreen({
      status: "ok",
      accounts: [{ ...CHECKING, id: "a2", name: "Old account", closedAt: "2026-02-01" }],
    });

    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.getByText("Old account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("closes an open account and refreshes the list", async () => {
    const refetch = vi.fn();
    const closeAccount = vi.spyOn(accountsApi, "closeAccount").mockResolvedValue({ ...CHECKING, closedAt: "2026-03-01" });
    renderScreen({ status: "ok", accounts: [CHECKING] }, refetch);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(closeAccount).toHaveBeenCalledWith("t", "ws-1", "a1"));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
