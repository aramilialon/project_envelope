import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError, type CsvMapping } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createTransaction, listTransactionsForAccount } from "../transactions/repository.ts";
import {
  confirmStagedTransactions,
  getImportMapping,
  listStagedTransactions,
  saveImportMapping,
  stageCsvImport,
  stageOfxImport,
  stageQifImport,
} from "./repository.ts";

function ofxTransaction(fitid: string, date: string, amountCents: number, payee: string): string {
  const amount = (amountCents / 100).toFixed(2);
  return (
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>" +
    `<STMTTRN><DTPOSTED>${date.replace(/-/g, "")}000000<TRNAMT>${amount}<FITID>${fitid}<NAME>${payee}</STMTTRN>` +
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"
  );
}

// A day past 12 settles the DD/MM/YYYY heuristic; the caller picks a date and amount accordingly.
function qifTransaction(date: string, amountCents: number, payee: string): string {
  const [year, month, day] = date.split("-") as [string, string, string];
  const amount = (amountCents / 100).toFixed(2).replace(".", ",");
  return `!Type:Bank\nD${day}/${month}/${year}\nP${payee}\nT${amount}\n^\n`;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const MAPPING: CsvMapping = {
  hasHeaderRow: true,
  dateColumn: 0,
  dateFormat: "YYYY-MM-DD",
  descriptionColumn: 1,
  amountColumn: 2,
  decimalSeparator: ".",
};

describe("import repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let accountId: string;
  let otherAccountId: string;
  let categoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const otherAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Savings', 'savings', 'EUR') RETURNING id",
      [workspaceId],
    );
    otherAccountId = otherAccount.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("saves and reads back an account's CSV mapping", async () => {
    assert.equal(await getImportMapping(pool, workspaceId, accountId), undefined);

    const saved = await saveImportMapping(pool, workspaceId, accountId, MAPPING);
    assert.deepEqual(saved, MAPPING);

    const read = await getImportMapping(pool, workspaceId, accountId);
    assert.deepEqual(read, MAPPING);
  });

  it("overwrites an existing mapping instead of erroring", async () => {
    const changed: CsvMapping = { ...MAPPING, decimalSeparator: "," };
    await saveImportMapping(pool, workspaceId, accountId, changed);
    const read = await getImportMapping(pool, workspaceId, accountId);
    assert.deepEqual(read, changed);
    await saveImportMapping(pool, workspaceId, accountId, MAPPING); // restore for the following tests
  });

  it("stages a CSV file's rows, none of them matching an existing transaction", async () => {
    const content = "Date,Description,Amount\n2026-09-15,Grocery store,-42.50\n2026-09-16,Salary,1000.00\n";
    const result = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    assert.equal(result.staged.length, 2);
    assert.equal(result.duplicateCount, 0);
    assert.equal(result.staged[0]?.duplicateOf, null);
    assert.equal(result.staged[0]?.amountCents, -4250);
    assert.equal(result.staged[0]?.payee, "Grocery store");
  });

  it("keeps a staged row's date exactly as given, independent of the server process's own time zone (#278)", async () => {
    const content = "Date,Description,Amount\n2026-01-31,Late night purchase,-1.00\n";
    const result = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    assert.equal(result.staged[0]?.occurredAt, "2026-01-31");
  });

  it("matches a staged row against an existing transaction within the 3-day window", async () => {
    const existing = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-10-01",
      payee: "Electric company",
      status: "pending",
      splits: [{ categoryId, amountCents: -6000 }],
    });

    const content = "Date,Description,Amount\n2026-10-02,Electric co,-60.00\n";
    const result = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.staged[0]?.duplicateOf, existing.id);
  });

  it("compares the file's closing balance with the account's projected balance", async () => {
    const before = await listTransactionsForAccount(pool, workspaceId, otherAccountId);
    assert.equal(before.length, 0);

    const content = "Date,Description,Amount\n2026-11-01,Coffee,-3.50\n2026-11-02,Salary,1500.00\n";
    const result = await stageCsvImport(pool, workspaceId, otherAccountId, content, MAPPING, 149650);
    assert.ok(result.closingBalance);
    assert.equal(result.closingBalance?.projectedCents, 149650); // 0 + (-350 + 150000)
    assert.equal(result.closingBalance?.differenceCents, 0);
  });

  it("lists staged transactions oldest first and sweeps rows past the 7-day expiry", async () => {
    const content = "Date,Description,Amount\n2026-12-01,Old row,-100.00\n";
    const staged = await stageCsvImport(pool, workspaceId, otherAccountId, content, MAPPING);
    const staleId = staged.staged[0]!.id;
    await pool.query("UPDATE staged_transactions SET created_at = now() - interval '8 days' WHERE id = $1", [staleId]);

    const remaining = await listStagedTransactions(pool, workspaceId, otherAccountId);
    assert.ok(!remaining.some((r) => r.id === staleId));
  });

  it("confirms a row as a categorized transaction and removes it from staging", async () => {
    const content = "Date,Description,Amount\n2026-09-20,Bookstore,-1500\n";
    const staged = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    const stagedId = staged.staged[0]!.id;

    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: stagedId, kind: "category", categoryId },
    ]);
    assert.equal(outcomes[0]?.outcome, "confirmed");
    assert.ok(outcomes[0] && "transactionId" in outcomes[0] && outcomes[0].transactionId);

    const remaining = await listStagedTransactions(pool, workspaceId, accountId);
    assert.ok(!remaining.some((r) => r.id === stagedId));

    const transactions = await listTransactionsForAccount(pool, workspaceId, accountId);
    const created = transactions.find((t) => t.payee === "Bookstore");
    assert.equal(created?.status, "cleared");
    assert.equal(created?.splits[0]?.categoryId, categoryId);
  });

  it("confirms a row as income (null category)", async () => {
    const content = "Date,Description,Amount\n2026-09-21,Refund,25.00\n";
    const staged = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    const stagedId = staged.staged[0]!.id;

    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: stagedId, kind: "income" },
    ]);
    assert.equal(outcomes[0]?.outcome, "confirmed");

    const transactions = await listTransactionsForAccount(pool, workspaceId, accountId);
    const created = transactions.find((t) => t.payee === "Refund");
    assert.equal(created?.splits[0]?.categoryId, null);
    assert.equal(created?.splits[0]?.amountCents, 2500);
  });

  it("confirms a row as a transfer, creating both linked legs", async () => {
    const content = "Date,Description,Amount\n2026-09-22,To savings,-20.00\n";
    const staged = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    const stagedId = staged.staged[0]!.id;

    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: stagedId, kind: "transfer", otherAccountId },
    ]);
    assert.equal(outcomes[0]?.outcome, "confirmed");

    const sourceTransactions = await listTransactionsForAccount(pool, workspaceId, accountId);
    const sourceLeg = sourceTransactions.find((t) => t.payee === "To savings");
    assert.equal(sourceLeg?.splits[0]?.amountCents, -2000);
    assert.ok(sourceLeg?.transferId);

    const destinationTransactions = await listTransactionsForAccount(pool, workspaceId, otherAccountId);
    const destinationLeg = destinationTransactions.find((t) => t.id === sourceLeg?.transferId);
    assert.equal(destinationLeg?.splits[0]?.amountCents, 2000);
  });

  it("confirming a duplicate-matched row clears the existing transaction instead of creating a new one", async () => {
    const existing = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-25",
      payee: "Phone bill",
      status: "pending",
      splits: [{ categoryId, amountCents: -2500 }],
    });

    const content = "Date,Description,Amount\n2026-09-25,Phone company,-25.00\n";
    const staged = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    const stagedRow = staged.staged[0]!;
    assert.equal(stagedRow.duplicateOf, existing.id);

    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: stagedRow.id, kind: "category", categoryId },
    ]);
    assert.equal(outcomes[0]?.outcome, "duplicate_cleared");

    const transactions = await listTransactionsForAccount(pool, workspaceId, accountId);
    const cleared = transactions.find((t) => t.id === existing.id);
    assert.equal(cleared?.status, "cleared");
    assert.ok(!transactions.some((t) => t.payee === "Phone company" && t.id !== existing.id));
  });

  it("rejects a single bad decision without aborting the rest of the batch", async () => {
    const content = "Date,Description,Amount\n2026-09-26,Good row,-500\n2026-09-27,Bad row,-700\n";
    const staged = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    const [goodRow, badRow] = staged.staged;

    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: goodRow!.id, kind: "category", categoryId },
      { stagedTransactionId: badRow!.id, kind: "transfer", otherAccountId: accountId }, // same account as itself
    ]);
    assert.equal(outcomes[0]?.outcome, "confirmed");
    assert.equal(outcomes[1]?.outcome, "rejected");

    const remaining = await listStagedTransactions(pool, workspaceId, accountId);
    assert.ok(remaining.some((r) => r.id === badRow!.id)); // left staged for a retry
  });

  it("stages an OFX transaction, keeping the bank's own transaction id", async () => {
    const content = ofxTransaction("OFX-STAGE-1", "2026-10-10", -1500, "Coffee shop");
    const result = await stageOfxImport(pool, workspaceId, accountId, content);
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0]?.externalId, "OFX-STAGE-1");
    assert.equal(result.staged[0]?.amountCents, -1500);
    assert.equal(result.staged[0]?.payee, "Coffee shop");
  });

  it("matches a re-imported OFX row by its external id, even outside the 3-day date window", async () => {
    const firstImport = ofxTransaction("OFX-REIMPORT-1", "2026-10-01", -2000, "Bookstore");
    const staged = await stageOfxImport(pool, workspaceId, accountId, firstImport);
    const confirmed = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: staged.staged[0]!.id, kind: "category", categoryId },
    ]);
    assert.equal(confirmed[0]?.outcome, "confirmed");

    // A later re-download of the same statement, the bank now reporting a different date for the same FITID.
    const secondImport = ofxTransaction("OFX-REIMPORT-1", "2026-10-20", -2000, "Bookstore");
    const result = await stageOfxImport(pool, workspaceId, accountId, secondImport);
    assert.equal(result.duplicateCount, 1);
    assert.ok(result.staged[0]?.duplicateOf);
  });

  it("stages a QIF transaction, inferring its date format and decimal separator", async () => {
    const content = qifTransaction("2026-10-21", -1234, "Bakery");
    const result = await stageQifImport(pool, workspaceId, accountId, content);
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0]?.amountCents, -1234);
    assert.equal(result.staged[0]?.payee, "Bakery");
    assert.equal(result.staged[0]?.externalId, null); // QIF carries no bank transaction id, unlike OFX
  });

  it("propagates an ambiguous QIF date format as a ValidationError instead of guessing", async () => {
    const content = "!Type:Bank\nD05/06/2026\nPUnclear\nT-10,00\n^\n";
    await assert.rejects(
      () => stageQifImport(pool, workspaceId, accountId, content),
      (error: unknown) => isValidationError(error, "ambiguous_date_format"),
    );
  });

  it("honors an explicit QIF hint instead of the heuristic", async () => {
    // "05/06" is ambiguous either way; DD/MM would give month "06", MM/DD gives month "05" — checking
    // just the month (not the exact day) keeps this independent of #278's date read-back bug.
    const content = "!Type:Bank\nD05/06/2026\nPExplicit\nT-10,00\n^\n";
    const result = await stageQifImport(pool, workspaceId, accountId, content, { dateFormat: "MM/DD/YYYY" });
    assert.ok(result.staged[0]?.occurredAt.startsWith("2026-05"));
  });

  it("rejects a row named in the confirmation with no category, transfer or income recognition", async () => {
    const content = "Date,Description,Amount\n2026-09-28,Uncategorized row,-400\n";
    const staged = await stageCsvImport(pool, workspaceId, accountId, content, MAPPING);
    const stagedId = staged.staged[0]!.id;

    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: stagedId, kind: "invalid" },
    ]);
    assert.equal(outcomes[0]?.outcome, "rejected");

    const remaining = await listStagedTransactions(pool, workspaceId, accountId);
    assert.ok(remaining.some((r) => r.id === stagedId));
  });

  it("reports not_found for a decision naming an unknown staged transaction", async () => {
    const outcomes = await confirmStagedTransactions(pool, workspaceId, accountId, [
      { stagedTransactionId: randomUUID(), kind: "income" },
    ]);
    assert.equal(outcomes[0]?.outcome, "not_found");
  });
});
