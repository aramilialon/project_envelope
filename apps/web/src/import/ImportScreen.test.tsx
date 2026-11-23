import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../accounts/api.ts";
import * as accountsApi from "../accounts/api.ts";
import type { Category } from "../categories/api.ts";
import * as categoriesApi from "../categories/api.ts";
import { ApiError } from "../apiFetch.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "../workspaces/api.ts";
import * as importApi from "./api.ts";
import type { StageImportResult } from "./api.ts";
import ImportScreen from "./ImportScreen.tsx";

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

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

function renderScreen(accounts: Account[] = [CHECKING, SAVINGS], accountId = "acc-checking") {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue(accounts);
  vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
  vi.spyOn(importApi, "getImportMapping").mockResolvedValue(undefined);
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Family", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome", taxCountry: null },
  ]);
  return renderWithIntl(
    <MemoryRouter initialEntries={[`/ws-1/accounts/${accountId}/import`]}>
      <Routes>
        <Route path="/:workspaceId/accounts/:accountId/import" element={<ImportScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ImportScreen (#59)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(accountsApi, "listAccounts").mockReturnValue(new Promise(() => {}));
    vi.spyOn(categoriesApi, "listCategories").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking/import"]}>
        <Routes>
          <Route path="/:workspaceId/accounts/:accountId/import" element={<ImportScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading this account…");
  });

  it("guesses CSV columns from the header row and lets the user continue once a mapping is complete", async () => {
    renderScreen();
    await screen.findByText(/Checking/);

    const content = "Date,Description,Amount\n2026-09-01,Supermarket,-42.50\n";
    const file = csvFile("statement.csv", content);
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText("statement.csv");
    expect(screen.getByDisplayValue("Date")).toBeInTheDocument();
    expect(screen.getByText("Columns look good.")).toBeInTheDocument();

    const stageImport = vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [{ id: "s1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" }],
      duplicateCount: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(stageImport).toHaveBeenCalledWith("t", "ws-1", "acc-checking", {
        content,
        format: "csv",
        mapping: { hasHeaderRow: true, dateColumn: 0, dateFormat: "YYYY-MM-DD", descriptionColumn: 1, decimalSeparator: ".", amountColumn: 2 },
      }),
    );
    expect(await screen.findByText("Supermarket")).toBeInTheDocument();
  });

  it("stages a self-describing OFX file straight away, skipping the columns step", async () => {
    renderScreen();
    await screen.findByText(/Checking/);

    const result: StageImportResult = {
      staged: [{ id: "s1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" }],
      duplicateCount: 0,
    };
    const stageImport = vi.spyOn(importApi, "stageImport").mockResolvedValue(result);
    const file = new File(["<OFX></OFX>"], "statement.ofx", { type: "application/x-ofx" });
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(stageImport).toHaveBeenCalledWith("t", "ws-1", "acc-checking", { content: "<OFX></OFX>", format: "ofx" }));
    expect(await screen.findByText("Supermarket")).toBeInTheDocument();
    expect(screen.queryByText("Columns look good.")).not.toBeInTheDocument();
  });

  it("confirms a new row once a category is chosen, and always confirms a duplicate row", async () => {
    renderScreen();
    await screen.findByText(/Checking/);

    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [
        { id: "new-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" },
        { id: "dup-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-02", payee: "Rent", memo: null, amountCents: -85_000, externalId: null, duplicateOf: "existing-1", createdAt: "2026-09-02" },
      ],
      duplicateCount: 1,
    });
    const file = new File(["<OFX></OFX>"], "statement.ofx");
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("Supermarket");
    expect(screen.getByText("Still need a category")).toBeInTheDocument();

    // The duplicate alone is already enough to import (it needs no category of its own);
    // the new row needs one chosen before it counts too.
    expect(screen.getByRole("button", { name: "Import 1 transaction" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Category", { selector: "select" }), { target: { value: "cat-groceries" } });
    expect(screen.getByRole("button", { name: /Import 2 transactions/ })).toBeEnabled();

    const confirm = vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([
      { stagedTransactionId: "new-1", outcome: "confirmed", transactionId: "t1" },
      { stagedTransactionId: "dup-1", outcome: "duplicate_cleared", transactionId: "existing-1" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Import 2 transactions/ }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith("t", "ws-1", "acc-checking", [
        { stagedTransactionId: "new-1", kind: "category", categoryId: "cat-groceries" },
        { stagedTransactionId: "dup-1", kind: "income" },
      ]),
    );
    expect(await screen.findByText("Import complete")).toBeInTheDocument();
    expect(screen.getByText("1 transaction added as cleared, 1 already there marked cleared.")).toBeInTheDocument();
  });

  it("makes 'Reconcile now' the primary action only once the statement's closing balance actually differs (#404)", async () => {
    renderScreen();
    await screen.findByText(/Checking/);

    fireEvent.change(screen.getByLabelText(/Closing balance/), { target: { value: "100.00" } });
    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [{ id: "new-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" }],
      duplicateCount: 0,
      closingBalance: { statementCents: 10_000, projectedCents: 9_000, differenceCents: 1_000 },
    });
    const file = new File(["<OFX></OFX>"], "statement.ofx");
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("Supermarket");

    fireEvent.change(screen.getByLabelText("Category", { selector: "select" }), { target: { value: "cat-groceries" } });
    vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([{ stagedTransactionId: "new-1", outcome: "confirmed", transactionId: "t1" }]);
    fireEvent.click(screen.getByRole("button", { name: /Import 1 transaction/ }));

    expect(await screen.findByText(/differs from the account by/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconcile now" })).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Import another file" })).not.toHaveClass("primary");
  });

  it("says the account is closed when the API refuses staging or confirming into it (#729)", async () => {
    renderScreen();
    await screen.findByText(/Checking/);
    const input = document.querySelector("#import-file-in") as HTMLInputElement;

    vi.spyOn(importApi, "stageImport").mockRejectedValueOnce(new ApiError("409", 409, "account_closed", {}));
    fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement.ofx")] } });
    expect(await screen.findByText("This account is closed, so nothing can be imported into it.")).toBeInTheDocument();

    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [{ id: "new-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" }],
      duplicateCount: 0,
    });
    fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement2.ofx")] } });
    await screen.findByText("Supermarket");
    fireEvent.change(screen.getByLabelText("Category", { selector: "select" }), { target: { value: "cat-groceries" } });
    vi.spyOn(importApi, "confirmStagedTransactions").mockRejectedValue(new ApiError("409", 409, "account_closed", {}));
    fireEvent.click(screen.getByRole("button", { name: /Import 1 transaction/ }));

    expect(
      await screen.findByText("This account, or the other account of one of these transfers, is closed, so these transactions can't be imported."),
    ).toBeInTheDocument();
  });

  it("names both currencies when the API refuses a file in another currency, at step 1 (#672)", async () => {
    renderScreen();
    await screen.findByText(/Checking/);
    const input = document.querySelector("#import-file-in") as HTMLInputElement;

    vi.spyOn(importApi, "stageImport").mockRejectedValueOnce(
      new ApiError("400", 400, "currency_mismatch", { fileCurrency: "USD", accountCurrency: "EUR" }),
    );
    fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement.ofx")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A file can be imported only into an account in the same currency: this file's currency is US Dollar (USD), and this account's is Euro (EUR).",
    );

    // A stated currency that is not a code: the API names the account's alone.
    vi.spyOn(importApi, "stageImport").mockRejectedValueOnce(new ApiError("400", 400, "currency_mismatch", { accountCurrency: "EUR" }));
    fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement2.ofx")] } });
    expect(
      await screen.findByText(
        "A file can be imported only into an account in the same currency: this file states a currency we don't recognize, and this account's is Euro (EUR).",
      ),
    ).toBeInTheDocument();
  });

  it("refuses a self-describing file's amount with too many decimals at step 1, naming the file's currency as a cause (#671)", async () => {
    renderScreen([{ ...CHECKING, currency: "JPY" }]);
    await screen.findByText(/Checking/);
    const input = document.querySelector("#import-file-in") as HTMLInputElement;

    vi.spyOn(importApi, "stageImport").mockRejectedValueOnce(new ApiError("400", 400, "too_many_decimals", { decimals: 0, currency: "JPY" }));
    fireEvent.change(input, { target: { files: [new File(["!Type:Bank"], "statement.qif")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An amount in Japanese Yen (JPY) can't have decimal places: this file has an amount with more, so it was not imported. The file may be from an account in another currency.",
    );
  });

  it("refuses a CSV amount with too many decimals at step 2, and clears the error when the separator changes (#671)", async () => {
    renderScreen();
    await screen.findByText(/Checking/);
    const content = "Date,Description,Amount\n2026-09-01,Supermarket,-42.505\n";
    fireEvent.change(document.querySelector("#import-file-in") as HTMLInputElement, { target: { files: [csvFile("statement.csv", content)] } });
    await screen.findByText("statement.csv");

    vi.spyOn(importApi, "stageImport").mockRejectedValueOnce(new ApiError("400", 400, "too_many_decimals", { decimals: 2, currency: "EUR" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An amount in Euro (EUR) can have at most 2 decimal places: this file has an amount with more, so it was not imported. The decimal separator chosen may not be the file's, or the file may be from an account in another currency.",
    );

    fireEvent.change(screen.getByLabelText("Decimal separator"), { target: { value: "," } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends a closing balance above the cap on a single amount: a balance is not capped (#651)", async () => {
    renderScreen();
    await screen.findByText(/Checking/);

    fireEvent.change(screen.getByLabelText(/Closing balance/), { target: { value: "1,200,000,000.00" } });
    const stage = vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [{ id: "new-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" }],
      duplicateCount: 0,
      closingBalance: { statementCents: 120_000_000_000, projectedCents: 120_000_000_000, differenceCents: 0 },
    });
    const file = new File(["<OFX></OFX>"], "statement.ofx");
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("Supermarket");

    expect(stage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ closingBalanceCents: 120_000_000_000 }),
    );
  });

  it("leaves 'Import another file' as the primary action once the statement's closing balance already matches", async () => {
    renderScreen();
    await screen.findByText(/Checking/);

    fireEvent.change(screen.getByLabelText(/Closing balance/), { target: { value: "100.00" } });
    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [{ id: "new-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Supermarket", memo: null, amountCents: -4_250, externalId: null, duplicateOf: null, createdAt: "2026-09-01" }],
      duplicateCount: 0,
      closingBalance: { statementCents: 10_000, projectedCents: 10_000, differenceCents: 0 },
    });
    const file = new File(["<OFX></OFX>"], "statement.ofx");
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("Supermarket");

    fireEvent.change(screen.getByLabelText("Category", { selector: "select" }), { target: { value: "cat-groceries" } });
    vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([{ stagedTransactionId: "new-1", outcome: "confirmed", transactionId: "t1" }]);
    fireEvent.click(screen.getByRole("button", { name: /Import 1 transaction/ }));

    expect(await screen.findByText("The statement's closing balance matches the account.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconcile now" })).not.toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Import another file" })).toHaveClass("primary");
  });

  it("asks for a category on a transfer to an off-budget account, and sends it (#378, #379)", async () => {
    renderScreen([CHECKING, SAVINGS, BROKERAGE]);
    await screen.findByText(/Checking/);

    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [
        { id: "new-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "Brokerage deposit", memo: null, amountCents: -5_000, externalId: null, duplicateOf: null, createdAt: "2026-09-01" },
      ],
      duplicateCount: 0,
    });
    const file = new File(["<OFX></OFX>"], "statement.ofx");
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("Brokerage deposit");

    fireEvent.change(screen.getByLabelText("Category", { selector: "select" }), { target: { value: "__transfer__acc-brokerage" } });
    expect(screen.getByText("Needs a category")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 0 transactions" })).toBeDisabled();

    const transferCategorySelect = document.querySelector("#import-transfer-cat-new-1") as HTMLSelectElement;
    expect(transferCategorySelect).toBeInTheDocument();
    fireEvent.change(transferCategorySelect, { target: { value: "cat-groceries" } });
    expect(screen.getByRole("button", { name: "Import 1 transaction" })).toBeEnabled();

    const confirm = vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([
      { stagedTransactionId: "new-1", outcome: "confirmed", transactionId: "t1" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith("t", "ws-1", "acc-checking", [
        { stagedTransactionId: "new-1", kind: "transfer", otherAccountId: "acc-brokerage", categoryId: "cat-groceries" },
      ]),
    );
  });

  it("labels a transfer option by the row's own direction, not always 'to' (#399)", async () => {
    renderScreen([CHECKING, SAVINGS]);
    await screen.findByText(/Checking/);

    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [
        { id: "out-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "To savings", memo: null, amountCents: -5_000, externalId: null, duplicateOf: null, createdAt: "2026-09-01" },
        { id: "in-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-02", payee: "From savings", memo: null, amountCents: 3_000, externalId: null, duplicateOf: null, createdAt: "2026-09-02" },
      ],
      duplicateCount: 0,
    });
    const file = new File(["<OFX></OFX>"], "statement.ofx");
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("To savings");

    const outSelect = screen.getByLabelText("Category", { selector: "select[id='import-cat-out-1']" });
    const inSelect = screen.getByLabelText("Category", { selector: "select[id='import-cat-in-1']" });
    expect([...outSelect.querySelectorAll("option")].map((o) => o.textContent)).toContain("Transfer to Savings");
    expect([...inSelect.querySelectorAll("option")].map((o) => o.textContent)).toContain("Transfer from Savings");
  });

  it("offers transfers only with accounts in the same currency (#652)", async () => {
    const usBroker: Account = { ...BROKERAGE, id: "acc-us-broker", name: "US broker", currency: "USD" };
    renderScreen([CHECKING, SAVINGS, usBroker]);
    await screen.findByText(/Checking/);

    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [
        { id: "out-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "To broker", memo: null, amountCents: -5_000, externalId: null, duplicateOf: null, createdAt: "2026-09-01" },
      ],
      duplicateCount: 0,
    });
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement.ofx")] } });
    await screen.findByText("To broker");

    const options = [...screen.getByLabelText("Category", { selector: "select[id='import-cat-out-1']" }).querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Transfer to Savings");
    expect(options).not.toContain("Transfer to US broker");
  });

  it("offers no transfer with a closed account (#729)", async () => {
    const oldSavings: Account = { ...SAVINGS, id: "acc-old-savings", name: "Old savings", closedAt: "2026-10-01T00:00:00.000Z" };
    renderScreen([CHECKING, SAVINGS, oldSavings]);
    await screen.findByText(/Checking/);

    vi.spyOn(importApi, "stageImport").mockResolvedValue({
      staged: [
        { id: "out-1", workspaceId: "ws-1", accountId: "acc-checking", occurredAt: "2026-09-01", payee: "To savings", memo: null, amountCents: -5_000, externalId: null, duplicateOf: null, createdAt: "2026-09-01" },
      ],
      duplicateCount: 0,
    });
    const input = document.querySelector("#import-file-in") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement.ofx")] } });
    await screen.findByText("To savings");

    const options = [...screen.getByLabelText("Category", { selector: "select[id='import-cat-out-1']" }).querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Transfer to Savings");
    expect(options).not.toContain("Transfer to Old savings");
  });

  describe("a transfer from an off-budget account (#599)", () => {
    const VISA: Account = { ...CHECKING, id: "acc-visa", name: "Visa", type: "credit_card", paymentCategoryId: "cat-visa-payment" };

    async function stageOneInflow(accountId: string) {
      vi.spyOn(importApi, "stageImport").mockResolvedValue({
        staged: [
          { id: "in-1", workspaceId: "ws-1", accountId, occurredAt: "2026-09-12", payee: "Broker withdrawal", memo: null, amountCents: 500_000, externalId: null, duplicateOf: null, createdAt: "2026-09-12" },
        ],
        duplicateCount: 0,
      });
      const input = document.querySelector("#import-file-in") as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement.ofx")] } });
      await screen.findByText("Broker withdrawal");
      fireEvent.change(screen.getByLabelText("Category", { selector: "select[id='import-cat-in-1']" }), { target: { value: "__transfer__acc-brokerage" } });
      return document.querySelector("#import-transfer-cat-in-1") as HTMLSelectElement;
    }

    it("lands as Unassigned by default into a cash account, sending no category", async () => {
      renderScreen([CHECKING, BROKERAGE]);
      await screen.findByText(/Checking/);
      const transferCategorySelect = await stageOneInflow("acc-checking");

      expect([...transferCategorySelect.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Unassigned", "Groceries"]);
      expect(transferCategorySelect).toHaveValue("");
      expect(screen.queryByText("Needs a category")).not.toBeInTheDocument();
      const confirm = vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([
        { stagedTransactionId: "in-1", outcome: "confirmed", transactionId: "t1" },
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));

      await waitFor(() =>
        expect(confirm).toHaveBeenCalledWith("t", "ws-1", "acc-checking", [{ stagedTransactionId: "in-1", kind: "transfer", otherAccountId: "acc-brokerage" }]),
      );
    });

    it("goes into a chosen category instead", async () => {
      renderScreen([CHECKING, BROKERAGE]);
      await screen.findByText(/Checking/);
      const transferCategorySelect = await stageOneInflow("acc-checking");
      fireEvent.change(transferCategorySelect, { target: { value: "cat-groceries" } });
      const confirm = vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([
        { stagedTransactionId: "in-1", outcome: "confirmed", transactionId: "t1" },
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));

      await waitFor(() =>
        expect(confirm).toHaveBeenCalledWith("t", "ws-1", "acc-checking", [
          { stagedTransactionId: "in-1", kind: "transfer", otherAccountId: "acc-brokerage", categoryId: "cat-groceries" },
        ]),
      );
    });

    it("still needs a category into an on-budget card", async () => {
      renderScreen([CHECKING, VISA, BROKERAGE], "acc-visa");
      await screen.findByText(/Visa/);
      const transferCategorySelect = await stageOneInflow("acc-visa");

      expect([...transferCategorySelect.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Choose a category", "Groceries"]);
      expect(screen.getByText("Needs a category")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import 0 transactions" })).toBeDisabled();
    });
  });

  describe("into an off-budget account (#710)", () => {
    async function stageTwoRows() {
      vi.spyOn(importApi, "stageImport").mockResolvedValue({
        staged: [
          { id: "out-1", workspaceId: "ws-1", accountId: "acc-brokerage", occurredAt: "2026-09-10", payee: "Custody fee", memo: null, amountCents: -400, externalId: null, duplicateOf: null, createdAt: "2026-09-10" },
          { id: "in-1", workspaceId: "ws-1", accountId: "acc-brokerage", occurredAt: "2026-09-11", payee: "Interest", memo: null, amountCents: 120, externalId: null, duplicateOf: null, createdAt: "2026-09-11" },
        ],
        duplicateCount: 0,
      });
      const input = document.querySelector("#import-file-in") as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(["<OFX></OFX>"], "statement.ofx")] } });
      await screen.findByText("Custody fee");
    }

    it("takes every new row as it is, offering no category and no 'Income', only transfers", async () => {
      renderScreen([CHECKING, BROKERAGE], "acc-brokerage");
      await screen.findByText(/Brokerage/);
      await stageTwoRows();

      const options = [...screen.getByLabelText("Category", { selector: "select[id='import-cat-out-1']" }).querySelectorAll("option")].map((o) => o.textContent);
      expect(options).toEqual(["No category", "Transfer to Checking"]);
      expect(screen.queryByText("Needs a category")).not.toBeInTheDocument();
      // Nothing on an off-budget account still needs a category, so the count is not shown (#710).
      expect(screen.queryByText("Still need a category")).not.toBeInTheDocument();
      expect(screen.getByText(/This account is off budget, so a new row takes no category/)).toBeInTheDocument();

      const confirm = vi.spyOn(importApi, "confirmStagedTransactions").mockResolvedValue([
        { stagedTransactionId: "out-1", outcome: "confirmed", transactionId: "t1" },
        { stagedTransactionId: "in-1", outcome: "confirmed", transactionId: "t2" },
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Import 2 transactions" }));

      await waitFor(() =>
        expect(confirm).toHaveBeenCalledWith("t", "ws-1", "acc-brokerage", [
          { stagedTransactionId: "out-1", kind: "income" },
          { stagedTransactionId: "in-1", kind: "income" },
        ]),
      );
    });

    it("still asks the on-budget leg's category for a transfer into the budget", async () => {
      renderScreen([CHECKING, BROKERAGE], "acc-brokerage");
      await screen.findByText(/Brokerage/);
      await stageTwoRows();

      fireEvent.change(screen.getByLabelText("Category", { selector: "select[id='import-cat-out-1']" }), { target: { value: "__transfer__acc-checking" } });
      const transferCategory = document.querySelector("#import-transfer-cat-out-1") as HTMLSelectElement;
      // Money from the off-budget account into a cash account: "Unassigned" first, as in the form (#599).
      expect([...transferCategory.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Unassigned", "Groceries"]);
      expect(screen.queryByText("Needs a category")).not.toBeInTheDocument();
      expect(screen.queryByText("Still need a category")).not.toBeInTheDocument();
    });

    it("counts what still needs a category only while a transfer out of the budget lacks one", async () => {
      renderScreen([CHECKING, BROKERAGE], "acc-brokerage");
      await screen.findByText(/Brokerage/);
      await stageTwoRows();

      // Money coming in from Checking leaves the budget, so Checking's leg needs a category (#378).
      fireEvent.change(screen.getByLabelText("Category", { selector: "select[id='import-cat-in-1']" }), { target: { value: "__transfer__acc-checking" } });
      expect(screen.getByText("Still need a category")).toBeInTheDocument();
    });
  });
});
