import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
import * as workspacesApi from "../workspaces/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import AppLayout from "./AppLayout.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const WORKSPACE = { id: "ws-1", name: "Famiglia", role: "owner" as const, baseCurrency: "EUR" };

function renderLayout() {
  useAuth.mockReturnValue({
    user: { access_token: "t", profile: { name: "Giorgio" } },
    signoutRedirect: vi.fn(),
  });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([WORKSPACE]);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1"]}>
      <Routes>
        <Route path="/:workspaceId" element={<AppLayout />}>
          <Route index element={<p>Budget screen</p>} />
          <Route path="accounts" element={<p>Accounts screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout (#51)", () => {
  it("shows the primary navigation, with the current screen marked current", async () => {
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([]);
    renderLayout();

    expect(await screen.findByRole("link", { name: "Budget" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Accounts" })).not.toHaveAttribute("aria-current");
  });

  it("omits Portfolio from the primary navigation: it has no screen yet", async () => {
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([]);
    renderLayout();

    await screen.findByRole("link", { name: "Budget" });
    expect(screen.queryByText(/portfolio/i)).not.toBeInTheDocument();
  });

  it("lists open on-budget and off-budget accounts in the sidebar ledger, grouped", async () => {
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([
      { id: "a1", workspaceId: "ws-1", name: "Checking", type: "checking", currency: "EUR", onBudget: true, paymentCategoryId: null, closedAt: null, createdAt: "2026-01-01" },
      { id: "a2", workspaceId: "ws-1", name: "Mortgage", type: "checking", currency: "EUR", onBudget: false, paymentCategoryId: null, closedAt: null, createdAt: "2026-01-01" },
      { id: "a3", workspaceId: "ws-1", name: "Closed account", type: "cash", currency: "EUR", onBudget: true, paymentCategoryId: null, closedAt: "2026-02-01", createdAt: "2026-01-01" },
    ]);
    renderLayout();

    expect(await screen.findByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("Mortgage")).toBeInTheDocument();
    expect(screen.queryByText("Closed account")).not.toBeInTheDocument();
  });

  it("opens the add-account form from the sidebar, and refreshes the ledger once created", async () => {
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([]);
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue({
      id: "a1",
      workspaceId: "ws-1",
      name: "Checking",
      type: "checking",
      currency: "EUR",
      onBudget: true,
      paymentCategoryId: null,
      closedAt: null,
      createdAt: "2026-01-01",
    });
    renderLayout();

    fireEvent.click(await screen.findByRole("button", { name: "+ Add account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Checking" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith("t", "ws-1", {
        name: "Checking",
        type: "checking",
        currency: "EUR",
        onBudget: true,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("signs out through react-oidc-context when the sign-out button is clicked", async () => {
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([]);
    const signoutRedirect = vi.fn();
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { name: "Giorgio" } }, signoutRedirect });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([WORKSPACE]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<AppLayout />}>
            <Route index element={<p>Budget screen</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(signoutRedirect).toHaveBeenCalledOnce();
  });
});
