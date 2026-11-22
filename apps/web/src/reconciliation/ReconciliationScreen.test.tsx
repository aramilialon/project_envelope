import { MAX_AMOUNT_CENTS } from "@envelope/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../accounts/api.ts";
import * as accountsApi from "../accounts/api.ts";
import { ApiError } from "../apiFetch.ts";
import type { Category } from "../categories/api.ts";
import * as categoriesApi from "../categories/api.ts";
import { AMOUNT_TOO_LARGE_EUR, renderWithIntl, typedAmount } from "../test-utils.tsx";
import * as transactionsApi from "../transactions/api.ts";
import type { Workspace } from "../workspaces/api.ts";
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
    { id: "ws-1", name: "Family", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome", taxCountry: null },
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

  it("shows amounts in the account's own currency, not the workspace's (#652)", async () => {
    // Queued before `renderScreen` sets its own default, so this one answers the screen's only read.
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValueOnce([{ ...CHECKING, name: "US broker", type: "brokerage", currency: "USD", onBudget: false }]);
    renderScreen(candidates());
    await screen.findByText(/US broker/);

    expect(screen.getByText("$515.00")).toBeInTheDocument();
    expect(screen.queryByText("€515.00")).not.toBeInTheDocument();
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
      { id: "ws-1", name: "Family", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome", taxCountry: null },
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

  it("says why when the API refuses an adjustment with no category on a credit card (#548)", async () => {
    renderScreen(candidates());
    await screen.findByText(/Checking/);
    vi.spyOn(reconciliationApi, "reconcileAccount").mockRejectedValue(
      new ApiError("POST failed: 400", 400, "card_income_not_supported", { accountId: "acc-checking" }),
    );

    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "520.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add an adjustment of €5.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm the adjustment" }));

    expect(await screen.findByText("On a credit card, an adjustment needs a category.")).toBeInTheDocument();
    expect(screen.queryByText("Reconciliation complete")).not.toBeInTheDocument();
  });

  it("takes a statement balance above the cap on a single amount: a balance is not capped (#651)", async () => {
    const BALANCE = (MAX_AMOUNT_CENTS / 10) * 12;
    renderScreen(candidates({ lastReconciledBalanceCents: BALANCE - 1_500 }));
    await screen.findByText(/Checking/);
    const reconcile = vi.spyOn(reconciliationApi, "reconcileAccount").mockResolvedValue({
      outcome: "reconciled",
      reconciliation: { id: "r1", workspaceId: "ws-1", accountId: "acc-checking", reconciledAt: "2026-09-26", statementBalanceCents: BALANCE, userId: "u1", brokenAt: null, createdAt: "2026-09-26" },
    });

    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: typedAmount(BALANCE) } });
    expect(screen.getByText("Everything matches.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lock 2 transactions" }));

    await waitFor(() => expect(screen.getByText("Reconciliation complete")).toBeInTheDocument());
    expect(reconcile).toHaveBeenCalledWith("t", "ws-1", "acc-checking", expect.objectContaining({ statementBalanceCents: BALANCE }));
  });

  it("says how large an amount can be when the API refuses an adjustment above the cap (#651)", async () => {
    renderScreen(candidates());
    await screen.findByText(/Checking/);
    vi.spyOn(reconciliationApi, "reconcileAccount").mockRejectedValue(
      new ApiError("POST failed: 400", 400, "amount_too_large", { label: "adjustment", max: MAX_AMOUNT_CENTS, value: String((MAX_AMOUNT_CENTS / 10) * 11) }),
    );

    fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "520.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add an adjustment of €5.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm the adjustment" }));

    expect(await screen.findByText(AMOUNT_TOO_LARGE_EUR)).toBeInTheDocument();
  });

  describe("a write the API refuses because the account is closed (#741)", () => {
    const closedRefusal = () => new ApiError("POST failed: 409", 409, "account_closed", {});
    const otherFailure = () => new ApiError("POST failed: 500", 500, "internal_error", {});
    const pending = candidates({ pendingTransactions: [{ id: "t-p", occurredAt: "2026-09-20", payee: "Gym", amountCents: -500 }] });

    it("says the account is closed when an adjustment is refused", async () => {
      renderScreen(candidates());
      await screen.findByText(/Checking/);
      vi.spyOn(reconciliationApi, "reconcileAccount").mockRejectedValue(closedRefusal());

      fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "520.00" } });
      fireEvent.click(screen.getByRole("button", { name: "Add an adjustment of €5.00" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm the adjustment" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("This account is closed, so it can't be reconciled.");
      expect(screen.queryByText("Reconciliation complete")).not.toBeInTheDocument();
    });

    it("keeps the plain failure for an adjustment refused for any other reason", async () => {
      renderScreen(candidates());
      await screen.findByText(/Checking/);
      vi.spyOn(reconciliationApi, "reconcileAccount").mockRejectedValue(otherFailure());

      fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "520.00" } });
      fireEvent.click(screen.getByRole("button", { name: "Add an adjustment of €5.00" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm the adjustment" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("We could not complete this reconciliation.");
    });

    it("says the account is closed when locking is refused, and keeps the plain failure otherwise", async () => {
      renderScreen(candidates());
      await screen.findByText(/Checking/);
      vi.spyOn(reconciliationApi, "reconcileAccount").mockRejectedValueOnce(closedRefusal()).mockRejectedValueOnce(otherFailure());

      fireEvent.change(screen.getByLabelText("Statement balance"), { target: { value: "515.00" } });
      fireEvent.click(screen.getByRole("button", { name: "Lock 2 transactions" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This account is closed, so it can't be reconciled.");

      fireEvent.click(screen.getByRole("button", { name: "Lock 2 transactions" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("We could not complete this reconciliation."));
    });

    it("says the account is closed when ticking a pending transaction is refused", async () => {
      vi.spyOn(transactionsApi, "updateTransaction").mockRejectedValue(closedRefusal());
      renderScreen(pending);
      await screen.findByText(/Checking/);

      fireEvent.click(screen.getByRole("checkbox", { name: /Gym/ }));

      expect(await screen.findByRole("alert")).toHaveTextContent("This account is closed, so its transactions can't be changed.");
      expect(screen.getByRole("checkbox", { name: /Gym/ })).not.toBeChecked();
    });

    it("says plainly that ticking a pending transaction failed for any other reason", async () => {
      vi.spyOn(transactionsApi, "updateTransaction").mockRejectedValue(otherFailure());
      renderScreen(pending);
      await screen.findByText(/Checking/);

      fireEvent.click(screen.getByRole("checkbox", { name: /Gym/ }));

      expect(await screen.findByRole("alert")).toHaveTextContent("We could not mark this transaction as cleared.");
    });
  });

  describe("the 'As of' date follows the workspace's time zone (#814)", () => {
    const ROME: Workspace = { id: "ws-1", name: "Family", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome", taxCountry: null };

    function ui() {
      return (
        <IntlProvider locale="en" defaultLocale="en" messages={{}}>
          <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking/reconcile"]}>
            <Routes>
              <Route path="/:workspaceId/accounts/:accountId/reconcile" element={<ReconciliationScreen />} />
            </Routes>
          </MemoryRouter>
        </IntlProvider>
      );
    }

    beforeEach(() => {
      // 22:30 UTC on 15 September is already 00:30 on 16 September in Rome; the browser is on UTC.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-15T22:30:00.000Z"));
      const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...resolvedOptions.call(this), timeZone: "UTC" };
      });
      useAuth.mockReturnValue({ user: { access_token: "t" } });
      vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
      vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts on the workspace's today, not the browser's, even when the workspace loads last", async () => {
      let answerWorkspaces: (workspaces: Workspace[]) => void = () => {};
      vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise((resolve) => (answerWorkspaces = resolve)));
      const getCandidates = vi.spyOn(reconciliationApi, "getReconciliationCandidates").mockResolvedValue(candidates());
      render(ui());

      // Nothing is asked for in the browser's own zone while the workspace is still loading.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByRole("status")).toHaveTextContent("Loading this account…");
      expect(getCandidates).not.toHaveBeenCalled();

      answerWorkspaces([ROME]);
      expect(await screen.findByLabelText("As of")).toHaveValue("2026-09-16");
      expect(getCandidates).toHaveBeenCalledTimes(1);
      expect(getCandidates).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "2026-09-16");
    });

    it("falls back on the browser's today when the workspace list fails, instead of loading forever", async () => {
      vi.spyOn(workspacesApi, "listMyWorkspaces").mockRejectedValue(new Error("unavailable"));
      const getCandidates = vi.spyOn(reconciliationApi, "getReconciliationCandidates").mockResolvedValue(candidates());
      render(ui());

      expect(await screen.findByLabelText("As of")).toHaveValue("2026-09-15");
      expect(getCandidates).toHaveBeenCalledTimes(1);
      expect(getCandidates).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "2026-09-15");
    });

    it("keeps a date the user changed when the workspace's time zone arrives again", async () => {
      const listWorkspaces = vi
        .spyOn(workspacesApi, "listMyWorkspaces")
        .mockResolvedValueOnce([ROME])
        // 22:30 UTC is 10:30 the next morning in Auckland: a new default would be 2026-09-16 again.
        .mockResolvedValueOnce([{ ...ROME, timeZone: "Pacific/Auckland" }]);
      const getCandidates = vi.spyOn(reconciliationApi, "getReconciliationCandidates").mockResolvedValue(candidates());
      const { rerender } = render(ui());
      expect(await screen.findByLabelText("As of")).toHaveValue("2026-09-16");

      fireEvent.change(screen.getByLabelText("As of"), { target: { value: "2026-09-01" } });
      await waitFor(() => expect(getCandidates).toHaveBeenLastCalledWith("t", "ws-1", "acc-checking", "2026-09-01"));

      // A token refresh fetches the workspaces again, with their time zone.
      useAuth.mockReturnValue({ user: { access_token: "t2" } });
      rerender(ui());
      await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(getCandidates).toHaveBeenLastCalledWith("t2", "ws-1", "acc-checking", "2026-09-01"));
      expect(screen.getByLabelText("As of")).toHaveValue("2026-09-01");
    });
  });
});
