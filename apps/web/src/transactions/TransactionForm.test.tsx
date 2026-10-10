import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Account } from "../accounts/api.ts";
import type { Category } from "../categories/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as transactionsApi from "./api.ts";
import type { Transaction } from "./api.ts";
import TransactionForm from "./TransactionForm.tsx";

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
const SAVINGS: Account = { ...CHECKING, id: "acc-savings", name: "Savings" };
const BROKERAGE: Account = { ...CHECKING, id: "acc-brokerage", name: "Brokerage", onBudget: false };
const GROCERIES: Category = { id: "cat-groceries", workspaceId: "ws-1", groupId: "g1", name: "Groceries", sortOrder: 1, archived: false };
const RESTAURANTS: Category = { id: "cat-restaurants", workspaceId: "ws-1", groupId: "g1", name: "Restaurants", sortOrder: 2, archived: false };

function renderForm(overrides: Partial<Parameters<typeof TransactionForm>[0]> = {}) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const rendered = renderWithIntl(
    <TransactionForm
      workspaceId="ws-1"
      accountId="acc-checking"
      accounts={[CHECKING, SAVINGS]}
      categories={[GROCERIES, RESTAURANTS]}
      currency="EUR"
      onClose={onClose}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { ...rendered, onClose, onSaved };
}

describe("TransactionForm (#54)", () => {
  it("creates an outflow with a category", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    const { onSaved } = renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Supermarket" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", {
        occurredAt: expect.any(String),
        payee: "Supermarket",
        status: "pending",
        splits: [{ categoryId: "cat-groceries", amountCents: -1250 }],
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("requires a category for an outflow", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");
  });

  it("creates an inflow with no category as ready-to-assign income", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    renderForm();

    fireEvent.click(screen.getByRole("radio", { name: "Inflow" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Salary" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createTransaction).toHaveBeenCalledWith(
        "t",
        "ws-1",
        "acc-checking",
        expect.objectContaining({ splits: [{ categoryId: null, amountCents: 10000 }] }),
      ),
    );
  });

  it("creates a transfer to another account", async () => {
    const createTransfer = vi.spyOn(transactionsApi, "createTransfer").mockResolvedValue({} as transactionsApi.Transfer);
    renderForm();

    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-savings" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createTransfer).toHaveBeenCalledWith("t", "ws-1", {
        sourceAccountId: "acc-checking",
        destinationAccountId: "acc-savings",
        occurredAt: expect.any(String),
        amountCents: 5000,
        status: "pending",
      }),
    );
  });

  it("requires a destination account for a transfer", async () => {
    renderForm();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a destination account.");
  });

  it("asks for a category on a transfer to an off-budget account, and sends it (#378)", async () => {
    const createTransfer = vi.spyOn(transactionsApi, "createTransfer").mockResolvedValue({} as transactionsApi.Transfer);
    renderForm({ accounts: [CHECKING, BROKERAGE] });

    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-brokerage" } });
    expect(screen.getByLabelText("Category")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");
    expect(createTransfer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createTransfer).toHaveBeenCalledWith(
        "t",
        "ws-1",
        expect.objectContaining({ destinationAccountId: "acc-brokerage", categoryId: "cat-groceries" }),
      ),
    );
  });

  it("does not ask for a category on a transfer between two on-budget accounts", async () => {
    renderForm();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-savings" } });
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
  });

  it("rejects an invalid amount without calling the API", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction");
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "not a number" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount greater than zero.");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("splits an outflow across two categories", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "30.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Split across categories" }));
    fireEvent.change(screen.getByLabelText("Line 1 category"), { target: { value: "cat-groceries" } });
    fireEvent.change(screen.getByLabelText("Line 1 amount"), { target: { value: "20.00" } });
    fireEvent.change(screen.getByLabelText("Line 2 category"), { target: { value: "cat-restaurants" } });
    fireEvent.change(screen.getByLabelText("Line 2 amount"), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createTransaction).toHaveBeenCalledWith(
        "t",
        "ws-1",
        "acc-checking",
        expect.objectContaining({
          splits: [
            { categoryId: "cat-groceries", amountCents: -2000 },
            { categoryId: "cat-restaurants", amountCents: -1000 },
          ],
        }),
      ),
    );
  });

  it("rejects split lines that do not add up to the total", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "30.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Split across categories" }));
    fireEvent.change(screen.getByLabelText("Line 1 category"), { target: { value: "cat-groceries" } });
    fireEvent.change(screen.getByLabelText("Line 1 amount"), { target: { value: "20.00" } });
    fireEvent.change(screen.getByLabelText("Line 2 category"), { target: { value: "cat-restaurants" } });
    fireEvent.change(screen.getByLabelText("Line 2 amount"), { target: { value: "5.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The split lines add up to");
  });

  it("edits an existing outflow, with the date disabled", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    const transaction: Transaction = {
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
    };
    renderForm({ transaction });

    expect(screen.getByLabelText("Date")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "15.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t1", {
        payee: "Supermarket",
        status: "cleared",
        splits: [{ categoryId: "cat-groceries", amountCents: -1500 }],
        amountCents: -1500,
      }),
    );
  });

  it("edits an existing transfer leg with amount and destination disabled", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    const transaction: Transaction = {
      id: "t2",
      workspaceId: "ws-1",
      accountId: "acc-checking",
      occurredAt: "2026-09-10T00:00:00.000Z",
      budgetDate: "2026-09-10",
      payee: null,
      memo: null,
      status: "pending",
      transferId: "t2-other",
      externalId: null,
      createdAt: "2026-09-10T00:00:00.000Z",
      splits: [{ id: "s2", categoryId: null, amountCents: -5000, memo: null }],
    };
    renderForm({ transaction });

    expect(screen.getByLabelText("Amount")).toBeDisabled();
    expect(screen.getByLabelText("To account")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Cleared against the bank"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t2", {
        status: "cleared",
      }),
    );
  });
});
