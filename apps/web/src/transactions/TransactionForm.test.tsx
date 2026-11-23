import { MAX_AMOUNT_CENTS, MAX_FREE_TEXT_LENGTH } from "@envelope/core";
import it_ from "@envelope/i18n/locales/it.json";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";

import type { Account } from "../accounts/api.ts";
import { ApiError } from "../apiFetch.ts";
import * as budgetApi from "../budget/api.ts";
import type { Category } from "../categories/api.ts";
import { AMOUNT_TOO_LARGE_EUR, renderWithIntl, typedAmount } from "../test-utils.tsx";
import * as transactionsApi from "./api.ts";
import type { Transaction } from "./api.ts";
import TransactionForm from "./TransactionForm.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));

/** The Idempotency-Key a create sends (#559): a fresh UUID per submit attempt. */
const IDEMPOTENCY_KEY = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
const VISA_PAYMENT: Category = { id: "cat-visa-payment", workspaceId: "ws-1", groupId: "g2", name: "Visa payment", sortOrder: 1, archived: false };
const VISA: Account = { ...CHECKING, id: "acc-visa", name: "Visa", type: "credit_card", paymentCategoryId: "cat-visa-payment" };

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
      today="2026-09-01"
      onClose={onClose}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { ...rendered, onClose, onSaved };
}

describe("TransactionForm (#54)", () => {
  it("caps the payee and the memo at the API's free-text limit (#507)", () => {
    renderForm();

    expect((screen.getByLabelText("Payee") as HTMLInputElement).maxLength).toBe(MAX_FREE_TEXT_LENGTH);
    expect((screen.getByLabelText("Memo") as HTMLInputElement).maxLength).toBe(MAX_FREE_TEXT_LENGTH);
  });

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
      }, IDEMPOTENCY_KEY),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("sends a new Idempotency-Key for each submit attempt (#559)", async () => {
    const createTransaction = vi
      .spyOn(transactionsApi, "createTransaction")
      .mockRejectedValueOnce(new ApiError("POST failed: 500", 500, "internal_error", {}))
      .mockResolvedValueOnce({} as Transaction);
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalledTimes(2));
    const [first, second] = createTransaction.mock.calls.map((call) => call[4]);
    expect(first).toEqual(IDEMPOTENCY_KEY);
    expect(second).toEqual(IDEMPOTENCY_KEY);
    expect(second).not.toBe(first);
  });

  it("lets a new transaction's own date be set, unlike an existing one's (#408)", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    renderForm();

    expect(screen.getByLabelText("Date")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-02" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10.00" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", expect.objectContaining({ occurredAt: "2026-09-02" }), IDEMPOTENCY_KEY));
  });

  it("requires a category for an outflow", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");
  });

  it("never offers a card's own payment category as an ordinary outflow's category (#386)", () => {
    renderForm({ accounts: [CHECKING, VISA], categories: [GROCERIES, RESTAURANTS, VISA_PAYMENT] });
    const options = [...screen.getByLabelText("Category").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Choose a category", "Groceries", "Restaurants"]);
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
        expect.objectContaining({ splits: [{ categoryId: null, amountCents: 10000 }] }), IDEMPOTENCY_KEY,
      ),
    );
  });

  it("says why when the API refuses income on a credit card (#548)", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockRejectedValue(
      new ApiError("POST failed: 400", 400, "card_income_not_supported", { accountId: "acc-visa" }),
    );
    const { onSaved } = renderForm({ accountId: "acc-visa", accounts: [CHECKING, VISA] });

    fireEvent.click(screen.getByRole("radio", { name: "Inflow" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5.00" } });
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Cashback" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText("Income on a credit card is not supported yet: choose a category for this inflow."),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says how long to wait when the API refuses a save over its rate limit (#566)", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockRejectedValue(
      new ApiError("POST failed: 429", 429, "too_many_requests", { retryAfterSeconds: 30 }),
    );
    const { onSaved } = renderForm({ accountId: "acc-visa", accounts: [CHECKING, VISA] });

    fireEvent.click(screen.getByRole("radio", { name: "Inflow" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5.00" } });
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Cashback" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Too many requests in a short time. Try again in 30 seconds.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
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
      }, IDEMPOTENCY_KEY),
    );
  });

  it("offers only accounts in the same currency for a transfer (#652)", () => {
    const usBroker: Account = { ...BROKERAGE, id: "acc-us-broker", name: "US broker", currency: "USD" };
    renderForm({ accounts: [CHECKING, SAVINGS, usBroker] });

    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    const options = within(screen.getByLabelText("To account")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Savings");
    expect(options).not.toContain("US broker");
  });

  it("leaves closed accounts out of a transfer's accounts (#729)", () => {
    const oldSavings: Account = { ...SAVINGS, id: "acc-old-savings", name: "Old savings", closedAt: "2026-10-01T00:00:00.000Z" };
    renderForm({ accounts: [CHECKING, SAVINGS, oldSavings] });

    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    const options = within(screen.getByLabelText("To account")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Savings");
    expect(options).not.toContain("Old savings");
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
        expect.objectContaining({ destinationAccountId: "acc-brokerage", categoryId: "cat-groceries" }), IDEMPOTENCY_KEY,
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

  it("says how large an amount can be when the typed one is above the cap (#651)", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction");
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: typedAmount(MAX_AMOUNT_CENTS + 1) } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("says the same when the API refuses an amount above the cap (#651)", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockRejectedValue(
      new ApiError("POST failed: 400", 400, "amount_too_large", { label: "total", max: MAX_AMOUNT_CENTS, value: String(MAX_AMOUNT_CENTS + 1) }),
    );
    const { onSaved } = renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: typedAmount(MAX_AMOUNT_CENTS) } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
    expect(onSaved).not.toHaveBeenCalled();
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
        }), IDEMPOTENCY_KEY,
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
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    };
    renderForm({ transaction });

    expect(screen.getByLabelText("Date")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "15.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t1", {
        splits: [{ categoryId: "cat-groceries", amountCents: -1500 }],
        amountCents: -1500,
      }),
    );
  });

  describe("only what changed, and text too long (#507)", () => {
    const longPayee = "p".repeat(600);
    const imported: Transaction = {
      id: "t9",
      workspaceId: "ws-1",
      accountId: "acc-checking",
      occurredAt: "2026-09-15T00:00:00.000Z",
      budgetDate: "2026-09-15",
      payee: longPayee,
      memo: "From the bank",
      status: "cleared",
      transferId: null,
      transferAccountId: null,
      externalId: "bank-1",
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits: [{ id: "s9", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    };

    it("saves a new category for a transaction with a 600-character payee, without re-sending the payee or memo", async () => {
      const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
      const { onSaved } = renderForm({ transaction: imported });

      fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-restaurants" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t9", {
        splits: [{ categoryId: "cat-restaurants", amountCents: -1200 }],
        amountCents: -1200,
      });
    });

    it("sends a changed memo, and nothing at all when nothing changed", async () => {
      const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
      updateTransaction.mockClear();
      const first = renderForm({ transaction: imported });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(first.onSaved).toHaveBeenCalled());
      expect(updateTransaction).not.toHaveBeenCalled();
      first.unmount();

      const second = renderForm({ transaction: imported });
      fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Weekly shopping" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(second.onSaved).toHaveBeenCalled());
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t9", { memo: "Weekly shopping" });
    });

    it("says which field is too long when the API refuses it", async () => {
      vi.spyOn(transactionsApi, "updateTransaction").mockRejectedValue(
        new ApiError("PATCH failed: 400", 400, "text_too_long", { field: "payee", max: MAX_FREE_TEXT_LENGTH }),
      );
      const { onSaved } = renderForm({ transaction: imported });

      fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "q".repeat(599) } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByText("The payee is too long: it can have up to 500 characters.")).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
    });
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
      transferAccountId: "acc-savings",
      externalId: null,
      tradeId: null,
      trade: null,
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

  it("deletes an existing transaction (#403)", async () => {
    const deleteTransaction = vi.spyOn(transactionsApi, "deleteTransaction").mockResolvedValue(undefined);
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
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    };
    const { onSaved } = renderForm({ transaction });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t1"));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("has no Delete button for a brand new transaction", () => {
    renderForm();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows an error and stays open when deleting fails", async () => {
    vi.spyOn(transactionsApi, "deleteTransaction").mockRejectedValue(new Error("409"));
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
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    };
    const { onSaved } = renderForm({ transaction });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not delete this transaction.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says how long to wait when the API refuses a delete over its rate limit (#729)", async () => {
    vi.spyOn(transactionsApi, "deleteTransaction").mockRejectedValue(
      new ApiError("DELETE failed: 429", 429, "too_many_requests", { retryAfterSeconds: 30 }),
    );
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
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -1200, memo: null }],
    };
    const { onSaved } = renderForm({ transaction });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests in a short time. Try again in 30 seconds.");
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("TransactionForm: each account in its own currency (#652)", () => {
  function editedIn(accountId: string, splits: Transaction["splits"]): Transaction {
    return {
      id: "t-fx",
      workspaceId: "ws-1",
      accountId,
      occurredAt: "2026-09-15T00:00:00.000Z",
      budgetDate: "2026-09-15",
      payee: "Shop",
      memo: null,
      status: "cleared",
      transferId: null,
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits,
    };
  }

  // On budget, as in a workspace whose base currency is theirs: an off-budget account takes no category (#710).
  const YEN: Account = { ...BROKERAGE, id: "acc-yen", name: "Yen account", type: "savings", currency: "JPY", onBudget: true };
  const DINAR: Account = { ...BROKERAGE, id: "acc-dinar", name: "Dinar account", type: "savings", currency: "KWD", onBudget: true };

  it("pre-fills a yen amount with no decimals, and saves it unchanged or changed", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    updateTransaction.mockClear();
    const transaction = editedIn("acc-yen", [{ id: "s1", categoryId: "cat-groceries", amountCents: -5000, memo: null }]);
    const first = renderForm({ accountId: "acc-yen", accounts: [YEN], currency: "JPY", transaction });

    expect(screen.getByLabelText("Amount")).toHaveValue("5,000");
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Bookshop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(first.onSaved).toHaveBeenCalled());
    expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-yen", "t-fx", { payee: "Bookshop" });
    first.unmount();

    const second = renderForm({ accountId: "acc-yen", accounts: [YEN], currency: "JPY", transaction });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "6,000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(second.onSaved).toHaveBeenCalled());
    expect(updateTransaction).toHaveBeenLastCalledWith("t", "ws-1", "acc-yen", "t-fx", {
      splits: [{ categoryId: "cat-groceries", amountCents: -6000 }],
      amountCents: -6000,
    });
  });

  it("pre-fills a three-decimal amount and its split lines with three decimals", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    updateTransaction.mockClear();
    const transaction = editedIn("acc-dinar", [
      { id: "s1", categoryId: "cat-groceries", amountCents: -1234, memo: null },
      { id: "s2", categoryId: "cat-restaurants", amountCents: -500, memo: null },
    ]);
    const { onSaved } = renderForm({ accountId: "acc-dinar", accounts: [DINAR], currency: "KWD", transaction });

    expect(screen.getByLabelText("Amount")).toHaveValue("1.734");
    expect(screen.getAllByDisplayValue("1.234")).toHaveLength(1);
    expect(screen.getAllByDisplayValue("0.500")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it("still shows and keeps the other account of a transfer leg written across currencies before #652", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    // Both on budget, so the leg has no category to ask for: only the currency differs.
    const usBroker: Account = { ...SAVINGS, id: "acc-us-broker", name: "US broker", currency: "USD" };
    const transaction: Transaction = {
      ...editedIn("acc-checking", [{ id: "s1", categoryId: null, amountCents: -5000, memo: null }]),
      payee: null,
      status: "pending",
      transferId: "t-fx-other",
      transferAccountId: "acc-us-broker",
    };
    renderForm({ accounts: [CHECKING, SAVINGS, usBroker], categories: [GROCERIES], transaction });

    const select = screen.getByLabelText("To account");
    expect(select).toHaveValue("acc-us-broker");
    expect(within(select).getAllByRole("option").some((option) => option.textContent?.startsWith("US broker"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Old move" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "t-fx", { memo: "Old move" }));
  });
});

describe("TransactionForm: money coming in from an off-budget account (#599)", () => {
  const BROKER: Account = { ...CHECKING, id: "acc-broker", name: "Broker", type: "brokerage", onBudget: false };

  function mockBudgetMonth() {
    return vi.spyOn(budgetApi, "getBudgetMonth").mockResolvedValue({
      month: "2026-09",
      unassigned: 20_000,
      assignedInFuture: 0,
      overspentLastMonth: 0,
      creditOverspending: 0,
      reserved: 0,
      categories: [
        {
          categoryId: "cat-groceries",
          name: "Groceries",
          groupId: "g1",
          groupName: "Everyday",
          sortOrder: 1,
          carriedOver: 0,
          assigned: 180_000,
          activity: 0,
          available: 180_000,
          creditOverspending: 0,
          cashOverspending: 0,
          reserved: 0,
          uncovered: 0,
        },
      ],
      paymentCategories: [],
    });
  }

  function leg(overrides: Partial<Transaction>): Transaction {
    return {
      id: "leg-in",
      workspaceId: "ws-1",
      accountId: "acc-checking",
      occurredAt: "2026-09-12T00:00:00.000Z",
      budgetDate: "2026-09-12",
      payee: null,
      memo: null,
      status: "pending",
      transferId: "leg-out",
      transferAccountId: "acc-broker",
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      splits: [{ id: "s-in", categoryId: null, amountCents: 500_000, memo: null }],
      ...overrides,
    };
  }

  function chooseIncomingFromBroker() {
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5000.00" } });
    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "acc-broker" } });
  }

  it("leaves credit cards out of the source accounts, and marks an off-budget one", () => {
    renderForm({ accounts: [CHECKING, SAVINGS, VISA, BROKER] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));

    const options = [...screen.getByLabelText("From account").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Choose an account", "Savings", "Broker (off budget)"]);
  });

  it("keeps the account already chosen when switching direction, but not a card as the source", () => {
    renderForm({ accounts: [CHECKING, SAVINGS, VISA, BROKER] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-savings" } });
    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));
    expect(screen.getByLabelText("From account")).toHaveValue("acc-savings");

    fireEvent.click(screen.getByRole("radio", { name: "To another account" }));
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-visa" } });
    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));
    expect(screen.getByLabelText("From account")).toHaveValue("");
  });

  it("offers Unassigned with its amount first, selected by default, says where the money lands, and sends no category", async () => {
    const getBudgetMonth = mockBudgetMonth();
    const createTransfer = vi.spyOn(transactionsApi, "createTransfer").mockResolvedValue({} as transactionsApi.Transfer);
    renderForm({ accounts: [CHECKING, VISA, BROKER] });
    chooseIncomingFromBroker();

    const category = screen.getByLabelText("Category");
    await waitFor(() => expect(category.querySelector("option")).toHaveTextContent("Unassigned (€200.00)"));
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", "2026-09");
    expect(category).toHaveValue("");
    expect([...category.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Unassigned (€200.00)", "Groceries", "Restaurants"]);
    expect(screen.getByText("The money comes into the budget: “Unassigned” goes from €200.00 to €5,200.00.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createTransfer).toHaveBeenCalledWith("t", "ws-1", {
        sourceAccountId: "acc-broker",
        destinationAccountId: "acc-checking",
        occurredAt: "2026-09-01",
        amountCents: 500_000,
        status: "pending",
      }, IDEMPOTENCY_KEY),
    );
  });

  it("says the day money dated after today comes into Unassigned, instead of adding it now (#700)", async () => {
    const getBudgetMonth = mockBudgetMonth();
    renderForm({ accounts: [CHECKING, BROKER] });
    chooseIncomingFromBroker();
    await screen.findByText("The money comes into the budget: “Unassigned” goes from €200.00 to €5,200.00.");

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-15" } });
    expect(await screen.findByText("The money comes into “Unassigned” on Sep 15.")).toBeInTheDocument();
    expect(screen.queryByText(/goes from/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toHaveAccessibleDescription("The money comes into “Unassigned” on Sep 15.");

    // A later month: the same, from that month's budget.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-02" } });
    expect(await screen.findByText("The money comes into “Unassigned” on Oct 2.")).toBeInTheDocument();
    expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", "2026-10");

    // Back to today: from and to again.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-01" } });
    expect(await screen.findByText("The money comes into the budget: “Unassigned” goes from €200.00 to €5,200.00.")).toBeInTheDocument();
  });

  it("names the year of a later date by the workspace's today, not the browser's (#814)", async () => {
    vi.spyOn(budgetApi, "getBudgetMonth").mockReturnValue(new Promise(() => {}));
    // The workspace is already in 2027 while the browser's clock still reads 2026.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    try {
      renderForm({ accounts: [CHECKING, BROKER], today: "2027-01-01" });
      chooseIncomingFromBroker();
      fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2027-01-15" } });
      expect(screen.getByText("The money comes into “Unassigned” on Jan 15.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the day money dated after today comes in at once, while the budget month loads and if it fails", async () => {
    const getBudgetMonth = vi.spyOn(budgetApi, "getBudgetMonth").mockReturnValue(new Promise(() => {}));
    renderForm({ accounts: [CHECKING, BROKER] });
    chooseIncomingFromBroker();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-15" } });
    expect(screen.getByText("The money comes into “Unassigned” on Sep 15.")).toBeInTheDocument();

    getBudgetMonth.mockRejectedValue(new Error("unavailable"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-02" } });
    await waitFor(() => expect(getBudgetMonth).toHaveBeenCalledWith("t", "ws-1", "2026-10"));
    expect(await screen.findByText("The money comes into “Unassigned” on Oct 2.")).toBeInTheDocument();

    // Today's date needs the amounts: no hint without them.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-01" } });
    await waitFor(() => expect(screen.queryByText(/The money comes into/)).not.toBeInTheDocument());
  });

  it("says the same for money sent from the off-budget account's own register with a later date", async () => {
    mockBudgetMonth();
    renderForm({ accountId: "acc-broker", accounts: [CHECKING, BROKER] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5000.00" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-checking" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-02" } });

    expect(await screen.findByText("The money comes into “Unassigned” on Sep 2.")).toBeInTheDocument();
  });

  it("says the day money dated after today comes into a chosen category too, instead of adding it now (#668)", async () => {
    mockBudgetMonth();
    renderForm({ accounts: [CHECKING, BROKER] });
    chooseIncomingFromBroker();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-15" } });
    await screen.findByText("The money comes into “Unassigned” on Sep 15.");

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    expect(screen.getByText("The money comes into Groceries on Sep 15.")).toBeInTheDocument();
    expect(screen.queryByText(/Groceries goes from/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toHaveAccessibleDescription("The money comes into Groceries on Sep 15.");

    // Back to today: from and to again.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-01" } });
    expect(await screen.findByText("The money comes into the budget: Groceries goes from €1,800.00 to €6,800.00.")).toBeInTheDocument();
  });

  it("puts the money in a chosen category instead, with the hint following it", async () => {
    mockBudgetMonth();
    const createTransfer = vi.spyOn(transactionsApi, "createTransfer").mockResolvedValue({} as transactionsApi.Transfer);
    renderForm({ accounts: [CHECKING, BROKER] });
    chooseIncomingFromBroker();

    await screen.findByText("The money comes into the budget: “Unassigned” goes from €200.00 to €5,200.00.");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    expect(screen.getByText("The money comes into the budget: Groceries goes from €1,800.00 to €6,800.00.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createTransfer).toHaveBeenCalledWith(
        "t",
        "ws-1",
        expect.objectContaining({ sourceAccountId: "acc-broker", destinationAccountId: "acc-checking", categoryId: "cat-groceries" }), IDEMPOTENCY_KEY,
      ),
    );
  });

  it("starts back at Unassigned when the transfer kind is chosen after a category", async () => {
    mockBudgetMonth();
    renderForm({ accounts: [CHECKING, BROKER] });
    chooseIncomingFromBroker();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("radio", { name: "Outflow" }));
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));

    expect(screen.getByLabelText("Category")).toHaveValue("");
  });

  it("still requires a category, with no Unassigned, from an off-budget account into an on-budget card", async () => {
    mockBudgetMonth();
    const createTransfer = vi.spyOn(transactionsApi, "createTransfer").mockResolvedValue({} as transactionsApi.Transfer);
    renderForm({ accountId: "acc-visa", accounts: [CHECKING, VISA, BROKER] });
    chooseIncomingFromBroker();

    const options = [...screen.getByLabelText("Category").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Choose a category", "Groceries", "Restaurants"]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");
    expect(createTransfer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createTransfer).toHaveBeenCalledWith(
        "t",
        "ws-1",
        expect.objectContaining({ sourceAccountId: "acc-broker", destinationAccountId: "acc-visa", categoryId: "cat-groceries" }), IDEMPOTENCY_KEY,
      ),
    );
  });

  it("still requires a category, with no Unassigned, going out to an off-budget account", () => {
    renderForm({ accounts: [CHECKING, BROKER] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-broker" } });

    const options = [...screen.getByLabelText("Category").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Choose a category", "Groceries", "Restaurants"]);
  });

  it("asks for no category coming in from an on-budget account", () => {
    renderForm({ accounts: [CHECKING, SAVINGS] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));
    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "acc-savings" } });
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
  });

  it("requires a source account", async () => {
    renderForm({ accounts: [CHECKING, BROKER] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a source account.");
  });

  it("sets a category on an existing Unassigned leg, leaving its amount alone", async () => {
    mockBudgetMonth();
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    renderForm({ accounts: [CHECKING, BROKER], transaction: leg({}) });

    expect(screen.getByRole("radio", { name: "From another account" })).toBeChecked();
    expect(screen.getByLabelText("From account")).toHaveValue("acc-broker");
    expect(screen.getByLabelText("From account")).toBeDisabled();
    expect(screen.getByLabelText("Category")).toHaveValue("");
    // The leg already counts in "Unassigned": no hint until the category changes.
    expect(screen.queryByText(/comes into the budget/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    // The leg is dated the 12th, after today (the 1st): Groceries gets it only then (#668).
    expect(await screen.findByText("The money comes into Groceries on Sep 12.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "leg-in", {
        splits: [{ categoryId: "cat-groceries", amountCents: 500_000 }],
        amountCents: 500_000,
      }),
    );
  });

  it("clears an existing leg's category back to Unassigned", async () => {
    mockBudgetMonth();
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    renderForm({
      accounts: [CHECKING, BROKER],
      transaction: leg({ splits: [{ id: "s-in", categoryId: "cat-groceries", amountCents: 500_000, memo: null }] }),
    });

    expect(screen.getByLabelText("Category")).toHaveValue("cat-groceries");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-checking", "leg-in", {
        splits: [{ categoryId: null, amountCents: 500_000 }],
        amountCents: 500_000,
      }),
    );
  });

  it("does not let an existing leg going out to an off-budget account lose its category", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    renderForm({
      accounts: [CHECKING, BROKER],
      transaction: leg({ splits: [{ id: "s-out", categoryId: "cat-groceries", amountCents: -500_000, memo: null }] }),
    });

    expect(screen.getByRole("radio", { name: "To another account" })).toBeChecked();
    expect(screen.getByLabelText("To account")).toHaveValue("acc-broker");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it("offers no category on the off-budget leg itself", () => {
    renderForm({
      accountId: "acc-broker",
      accounts: [CHECKING, BROKER],
      transaction: leg({ accountId: "acc-broker", transferAccountId: "acc-checking", splits: [{ id: "s-out", categoryId: null, amountCents: -500_000, memo: null }] }),
    });
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
  });

  it("links the hint to the category it describes", async () => {
    mockBudgetMonth();
    renderForm({ accounts: [CHECKING, BROKER] });
    chooseIncomingFromBroker();

    await waitFor(() =>
      expect(screen.getByLabelText("Category")).toHaveAccessibleDescription(
        "The money comes into the budget: “Unassigned” goes from €200.00 to €5,200.00.",
      ),
    );
  });

  it("drops a split left on when the kind changes, so a transfer still shows its category", () => {
    renderForm({ accounts: [CHECKING, BROKER] });
    fireEvent.click(screen.getByRole("button", { name: "Split across categories" }));
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-broker" } });
    expect(screen.getByLabelText("Category")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Outflow" }));
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Split across categories" })).toBeInTheDocument();
  });

  it("clears a stale message when the direction or the account changes", async () => {
    renderForm({ accounts: [CHECKING, SAVINGS, BROKER] });
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-broker" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");

    fireEvent.click(screen.getByRole("radio", { name: "From another account" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "To another account" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a category.");
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-savings" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("TransactionForm in Italian (#599)", () => {
  function renderInItalian(transaction?: Transaction) {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    return render(
      <IntlProvider locale="it" defaultLocale="en" messages={it_}>
        <TransactionForm
          workspaceId="ws-1"
          accountId="acc-checking"
          accounts={[CHECKING, SAVINGS]}
          categories={[GROCERIES]}
          currency="EUR"
          today="2026-09-01"
          {...(transaction ? { transaction } : {})}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </IntlProvider>,
    );
  }

  it("translates the title and the main button of a new and an edited transaction", () => {
    const { unmount } = renderInItalian();
    expect(screen.getByRole("heading", { name: "Nuova transazione" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aggiungi" })).toBeInTheDocument();
    unmount();

    renderInItalian({
      id: "tx-1",
      workspaceId: "ws-1",
      accountId: "acc-checking",
      occurredAt: "2026-09-12T00:00:00.000Z",
      budgetDate: "2026-09-12",
      payee: null,
      memo: null,
      status: "pending",
      transferId: null,
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      splits: [{ id: "s-1", categoryId: "cat-groceries", amountCents: -1250, memo: null }],
    });
    expect(screen.getByRole("heading", { name: "Modifica transazione" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salva" })).toBeInTheDocument();
  });

});

describe("TransactionForm: a write the API refuses because an account is closed (#729)", () => {
  const leg: Transaction = {
    id: "t2",
    workspaceId: "ws-1",
    accountId: "acc-checking",
    occurredAt: "2026-09-10T00:00:00.000Z",
    budgetDate: "2026-09-10",
    payee: null,
    memo: null,
    status: "pending",
    transferId: "t2-other",
    transferAccountId: "acc-savings",
    externalId: null,
    tradeId: null,
    trade: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    splits: [{ id: "s2", categoryId: null, amountCents: -5000, memo: null }],
  };
  const closedSavings: Account = { ...SAVINGS, closedAt: "2026-10-01T00:00:00.000Z" };
  const refusal = () => new ApiError("409", 409, "account_closed", {});

  it("says the transfer's other account is closed when deleting the open leg is refused", async () => {
    vi.spyOn(transactionsApi, "deleteTransaction").mockRejectedValue(refusal());
    const { onSaved } = renderForm({ transaction: leg, accounts: [CHECKING, closedSavings] });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This transfer's other account is closed, so this transfer can't be deleted.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says the transfer's other account is closed when saving the open leg is refused", async () => {
    vi.spyOn(transactionsApi, "updateTransaction").mockRejectedValue(refusal());
    renderForm({ transaction: leg, accounts: [CHECKING, closedSavings] });

    fireEvent.click(screen.getByLabelText("Cleared against the bank"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This transfer's other account is closed, so this transfer can't be changed.");
  });

  it("says this account is closed when a write to its own transaction is refused", async () => {
    vi.spyOn(transactionsApi, "updateTransaction").mockRejectedValue(refusal());
    vi.spyOn(transactionsApi, "deleteTransaction").mockRejectedValue(refusal());
    const own: Transaction = { ...leg, transferId: null, transferAccountId: null, splits: [{ id: "s2", categoryId: "cat-groceries", amountCents: -5000, memo: null }] };
    renderForm({ transaction: own, accounts: [{ ...CHECKING, closedAt: "2026-10-01T00:00:00.000Z" }, SAVINGS] });

    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "late" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This account is closed, so its transactions can't be changed.");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This account is closed, so its transactions can't be deleted."));
  });

  /** Fills in a new transfer from Checking to Savings and adds it. */
  function addTransfer() {
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "acc-savings" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  }

  it("says the transfer can't be added, not changed, when its other account was closed meanwhile (#741)", async () => {
    vi.spyOn(transactionsApi, "createTransfer").mockRejectedValue(refusal());
    // The form's list still shows Savings open: it was closed after the form opened.
    const { onSaved } = renderForm();

    addTransfer();

    expect(await screen.findByRole("alert")).toHaveTextContent("This transfer's other account is closed, so the transfer can't be added.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says this account is closed when adding a transfer from it is refused (#741)", async () => {
    vi.spyOn(transactionsApi, "createTransfer").mockRejectedValue(refusal());
    renderForm({ accounts: [{ ...CHECKING, closedAt: "2026-10-01T00:00:00.000Z" }, SAVINGS] });

    addTransfer();

    expect(await screen.findByRole("alert")).toHaveTextContent("This account is closed, so the transfer can't be added.");
  });

  it("says this account is closed when adding a transaction to it is refused, even before the form knew (#741)", async () => {
    vi.spyOn(transactionsApi, "createTransaction").mockRejectedValue(refusal());
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat-groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This account is closed, so the transaction can't be added.");
  });

  it("keeps the plain failure for any other refusal of a new transfer", async () => {
    vi.spyOn(transactionsApi, "createTransfer").mockRejectedValue(new ApiError("500", 500, "internal_error", {}));
    renderForm();

    addTransfer();

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not save this transaction.");
  });
});

describe("TransactionForm: off-budget accounts (#710) and trade cash legs (#657)", () => {
  const BROKER: Account = { ...CHECKING, id: "acc-broker", name: "Broker", type: "brokerage", onBudget: false };

  function onBroker(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: "t-ob",
      workspaceId: "ws-1",
      accountId: "acc-broker",
      occurredAt: "2026-09-15T00:00:00.000Z",
      budgetDate: "2026-09-15",
      payee: "Broker",
      memo: null,
      status: "pending",
      transferId: null,
      transferAccountId: null,
      externalId: null,
      tradeId: null,
      trade: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      splits: [{ id: "s1", categoryId: null, amountCents: -400, memo: null }],
      ...overrides,
    };
  }

  function renderOnBroker(transaction?: Transaction) {
    return renderForm({ accountId: "acc-broker", accounts: [CHECKING, BROKER], ...(transaction ? { transaction } : {}) });
  }

  it("asks for no category and offers no split on an off-budget account, and saves one line with none", async () => {
    const createTransaction = vi.spyOn(transactionsApi, "createTransaction").mockResolvedValue({} as Transaction);
    const { onSaved } = renderOnBroker();

    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split across categories" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4.00" } });
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Custody fee" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(createTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-broker", {
      occurredAt: "2026-09-01",
      payee: "Custody fee",
      status: "pending",
      splits: [{ categoryId: null, amountCents: -400 }],
    });
  });

  it("sends a row stored with a category before #710 back without it, even when only its memo changes", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    updateTransaction.mockClear();
    const { onSaved } = renderOnBroker(onBroker({ splits: [{ id: "s1", categoryId: "cat-groceries", amountCents: -400, memo: null }] }));

    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Custody" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-broker", "t-ob", {
      memo: "Custody",
      splits: [{ categoryId: null, amountCents: -400 }],
      amountCents: -400,
    });
  });

  it("folds a split row stored before #710 into one line with no category, at its total", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    updateTransaction.mockClear();
    renderOnBroker(
      onBroker({
        splits: [
          { id: "s1", categoryId: "cat-groceries", amountCents: -300, memo: null },
          { id: "s2", categoryId: "cat-restaurants", amountCents: -100, memo: null },
        ],
      }),
    );

    expect(screen.getByLabelText("Amount")).toHaveValue("4.00");
    expect(screen.queryByLabelText("Line 1 category")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-broker", "t-ob", {
        splits: [{ categoryId: null, amountCents: -400 }],
        amountCents: -400,
      }),
    );
  });

  it("leaves an unchanged off-budget row alone", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    updateTransaction.mockClear();
    const { onSaved } = renderOnBroker(onBroker());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["category_not_allowed", { field: "categoryId" }, "On an off-budget account, a transaction has no category."],
    ["unsupported_transaction", {}, "On an off-budget account, a transaction can't be split."],
  ])("says why the API refused an off-budget row (%s)", async (code, details, message) => {
    vi.spyOn(transactionsApi, "createTransaction").mockRejectedValue(new ApiError("POST failed: 400", 400, code, details));
    renderOnBroker();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  const BUY = onBroker({
    id: "t-leg",
    payee: null,
    tradeId: "trade-1",
    trade: { type: "buy", quantityE8: 1_000_000_000, instrumentId: "i-1", instrumentName: "World equity ETF", instrumentTicker: "WEQ" },
    splits: [{ id: "s1", categoryId: null, amountCents: -100_000, memo: null }],
  });

  it("locks a cash leg's amount, date, kind and category, with no Delete, and says where to change them", () => {
    renderOnBroker(BUY);

    expect(screen.getByLabelText("Amount")).toBeDisabled();
    expect(screen.getByLabelText("Date")).toBeDisabled();
    for (const kind of ["Outflow", "Inflow", "Transfer"]) {
      expect(screen.getByRole("radio", { name: kind })).toBeDisabled();
    }
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split across categories" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toHaveAccessibleDescription("This transaction belongs to “Buy · 10 × WEQ”: its amount and date change on the trade.");
    expect(screen.getByLabelText("Date")).toHaveAccessibleDescription("This transaction belongs to “Buy · 10 × WEQ”: its amount and date change on the trade.");
    // Its own fields stay editable.
    expect(screen.getByLabelText("Payee")).toBeEnabled();
    expect(screen.getByLabelText("Memo")).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Cleared against the bank" })).toBeEnabled();
  });

  it("saves only a cash leg's memo, payee and cleared status", async () => {
    const updateTransaction = vi.spyOn(transactionsApi, "updateTransaction").mockResolvedValue({} as Transaction);
    updateTransaction.mockClear();
    const { onSaved } = renderOnBroker(BUY);

    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Monthly plan" } });
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Broker" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Cleared against the bank" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(updateTransaction).toHaveBeenCalledWith("t", "ws-1", "acc-broker", "t-leg", { payee: "Broker", memo: "Monthly plan", status: "cleared" });
  });

  it("says that a cash leg changes on its trade when the API refuses an edit (409 trade_owned_transaction)", async () => {
    vi.spyOn(transactionsApi, "updateTransaction").mockRejectedValue(new ApiError("PATCH failed: 409", 409, "trade_owned_transaction", {}));
    const { onSaved } = renderOnBroker(BUY);

    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Monthly plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This transaction belongs to a trade: its amount, date and account change on the trade.");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
