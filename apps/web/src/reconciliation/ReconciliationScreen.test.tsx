import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../accounts/api.ts";
import * as accountsApi from "../accounts/api.ts";
import type { Category } from "../categories/api.ts";
import * as categoriesApi from "../categories/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as transactionsApi from "../transactions/api.ts";
import * as workspacesApi from "../workspaces/api.ts";
import * as reconciliationApi from "./api.ts";
import type { ReconciliationCandidates } from "./api.ts";
import ReconciliationScreen from "./ReconciliationScreen.tsx";

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

function candidates(overrides: Partial<ReconciliationCandidates> = {}): ReconciliationCandidates {
  return {
    lastReconciledBalanceCents: 50_000,
    clearedTransactions: [
      { id: "t-a", occurredAt: "2026-09-10", payee: "Supermarket", amountCents: -1_000 },
      { id: "t-b", occurredAt: "2026-09-12", payee: "Salary", amountCents: 2_500 },
    ],
    pendingTransactions: [],
    ...overrides,
  };
}

function renderScreen(initialCandidates: ReconciliationCandidates) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Family", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
  ]);
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
  vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
  vi.spyOn(reconciliationApi, "getReconciliationCandidates").mockResolvedValue(initialCandidates);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking/reconcile"]}>
      <Routes>
        <Route path="/:workspaceId/accounts/:accountId/reconcile" element={<ReconciliationScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReconciliationScreen (#60)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise(() => {}));
    vi.spyOn(accountsApi, "listAccounts").mockReturnValue(new Promise(() => {}));
    vi.spyOn(categoriesApi, "listCategories").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking/reconcile"]}>
        <Routes>
          <Route path="/:workspaceId/accounts/:accountId/reconcile" element={<ReconciliationScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading this account…");
  });

  it("computes the cleared balance and difference as the user types the statement balance", async () => {
    renderScreen(candidates());
    await screen.findByText(/Checking/);

    expect(screen.getByText("€515.00")).toBeInTheDocument(); // cleared balance: 500 + (-10 + 25)

    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "515.00" } });
    expect(screen.getByText("Everything matches.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock 2 transactions" })).toBeInTheDocument();
  });

  it("locks the ticked transactions on a zero difference", async () => {
    renderScreen(candidates());
    await screen.findByText(/Checking/);
    const reconcile = vi.spyOn(reconciliationApi, "reconcileAccount").mockResolvedValue({
      outcome: "reconciled",
      reconciliation: { id: "r1", workspaceId: "ws-1", accountId: "acc-checking", reconciledAt: "2026-09-26", statementBalanceCents: 51_500, userId: "u1", brokenAt: null, createdAt: "2026-09-26" },
    });

    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "515.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Lock 2 transactions" }));

    await waitFor(() => expect(screen.getByText("Reconciliation complete")).toBeInTheDocument());
    expect(reconcile).toHaveBeenCalledWith("t", "ws-1", "acc-checking", {
      date: expect.any(String),
      statementBalanceCents: 51_500,
      tickedTransactionIds: ["t-a", "t-b"],
    });
  });

  it("unticking a cleared transaction removes it from the tally", async () => {
    renderScreen(candidates());
    await screen.findByText(/Checking/);

    fireEvent.click(screen.getByRole("checkbox", { name: /Supermarket/ }));
    expect(screen.getByText("€525.00")).toBeInTheDocument(); // 500 + 25, the outflow removed
  });

  it("offers a one-click fix for a pending transaction matching the difference, and applies it", async () => {
    const markCleared = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as transactionsApi.Transaction);
    const getCandidates = vi
      .spyOn(reconciliationApi, "getReconciliationCandidates")
      .mockResolvedValueOnce(candidates({ pendingTransactions: [{ id: "t-p", occurredAt: "2026-09-20", payee: "Gym", amountCents: -500 }] }))
      .mockResolvedValueOnce(
        candidates({
          clearedTransactions: [
            { id: "t-a", occurredAt: "2026-09-10", payee: "Supermarket", amountCents: -1_000 },
            { id: "t-b", occurredAt: "2026-09-12", payee: "Salary", amountCents: 2_500 },
            { id: "t-p", occurredAt: "2026-09-20", payee: "Gym", amountCents: -500 },
          ],
        }),
      );
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Family", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
    vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking/reconcile"]}>
        <Routes>
          <Route path="/:workspaceId/accounts/:accountId/reconcile" element={<ReconciliationScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/Checking/);

    // Cleared balance is 515; a statement of 510 leaves a -5 difference, matching the pending Gym transaction.
    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "510.00" } });
    expect(screen.getByText(/The difference equals Gym from/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark it as cleared" }));
    await waitFor(() => expect(markCleared).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t-p", { status: "cleared" }));
    await waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(2));
  });

  it("lets the user add an adjustment transaction for a real difference, choosing its category", async () => {
    renderScreen(candidates());
    await screen.findByText(/Checking/);
    const reconcile = vi.spyOn(reconciliationApi, "reconcileAccount").mockResolvedValue({
      outcome: "reconciled",
      reconciliation: { id: "r1", workspaceId: "ws-1", accountId: "acc-checking", reconciledAt: "2026-09-26", statementBalanceCents: 52_000, userId: "u1", brokenAt: null, createdAt: "2026-09-26" },
    });

    // Cleared balance is 515; a statement of 520 leaves a +5 difference matching no transaction.
    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "520.00" } });
    expect(screen.getByText(/Check the transactions one by one/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add an adjustment of €5.00" }));
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm the adjustment" }));

    await waitFor(() => expect(screen.getByText("Reconciliation complete")).toBeInTheDocument());
    expect(reconcile).toHaveBeenCalledWith("t", "ws-1", "acc-checking", {
      date: expect.any(String),
      statementBalanceCents: 52_000,
      tickedTransactionIds: ["t-a", "t-b"],
      adjustment: { categoryId: "cat-groceries" },
    });
  });
});
