import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../accounts/api.ts";
import * as accountsApi from "../accounts/api.ts";
import type { Category } from "../categories/api.ts";
import * as categoriesApi from "../categories/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
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
const GROCERIES: Category = { id: "cat-groceries", workspaceId: "ws-1", groupId: "g1", name: "Groceries", sortOrder: 1, archived: false };

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

function renderScreen() {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING, SAVINGS]);
  vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([GROCERIES]);
  vi.spyOn(importApi, "getImportMapping").mockResolvedValue(undefined);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/accounts/acc-checking/import"]}>
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
});
