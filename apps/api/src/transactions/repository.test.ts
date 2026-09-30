import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createPostgresQueueDriver } from "../queue/postgres-driver.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { createTransaction, createTransfer, listTransactionsForAccount, updateTransaction } from "./repository.ts";

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("transactions repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let accountId: string;
  let savingsAccountId: string;
  let creditCardAccountId: string;
  let otherCreditCardAccountId: string;
  let categoryId: string;
  let otherCategoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    await ensureQueueRoleLogin(pool);

    workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'America/Los_Angeles')",
      [workspaceId],
    );
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const savingsAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Savings', 'savings', 'EUR') RETURNING id",
      [workspaceId],
    );
    savingsAccountId = savingsAccount.rows[0]!.id;
    const creditCardAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Card', 'credit_card', 'EUR', true) RETURNING id",
      [workspaceId],
    );
    creditCardAccountId = creditCardAccount.rows[0]!.id;
    const otherCreditCardAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Other card', 'credit_card', 'EUR', true) RETURNING id",
      [workspaceId],
    );
    otherCreditCardAccountId = otherCreditCardAccount.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
    const otherCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 2) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    otherCategoryId = otherCategory.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("creates a plain categorized transaction", async () => {
    const transaction = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-15T12:00:00Z",
      payee: "Grocery store",
      splits: [{ categoryId, amountCents: -5000 }],
    });
    assert.equal(transaction.status, "pending");
    assert.equal(transaction.splits.length, 1);
    assert.equal(transaction.splits[0]?.categoryId, categoryId);
    assert.equal(transaction.splits[0]?.amountCents, -5000); // a number, not a bigint string
  });

  it("creates an income transaction with categoryId null", async () => {
    const transaction = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-01T12:00:00Z",
      splits: [{ categoryId: null, amountCents: 300000 }],
    });
    assert.equal(transaction.splits[0]?.categoryId, null);
  });

  it("creates a split transaction across two categories", async () => {
    const transaction = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-02T12:00:00Z",
      splits: [
        { categoryId, amountCents: -3000 },
        { categoryId: otherCategoryId, amountCents: -2000 },
      ],
    });
    assert.equal(transaction.splits.length, 2);
  });

  it("converts occurred_at to the workspace's own time zone, not UTC", async () => {
    // 2026-09-15T02:00:00Z is still 2026-09-14 evening in America/Los_Angeles (UTC-7 in September).
    const transaction = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-15T02:00:00Z",
      splits: [{ categoryId, amountCents: -100 }],
    });
    assert.equal(transaction.budgetDate, "2026-09-14");
  });

  it("anchors a date-only occurredAt to midnight in the workspace's time zone, not UTC", async () => {
    // Without anchoring, Postgres would read a bare "2026-09-15" as midnight in this
    // connection's own session time zone (UTC in this dev setup) — one calendar day off
    // for a workspace west of Greenwich, like America/Los_Angeles.
    const transaction = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-15",
      splits: [{ categoryId, amountCents: -100 }],
    });
    assert.equal(transaction.budgetDate, "2026-09-15");
    assert.equal(transaction.occurredAt, "2026-09-15T07:00:00.000Z"); // midnight PDT (UTC-7 in September)
  });

  it("rejects an empty splits array", async () => {
    await assert.rejects(
      () => createTransaction(pool, { workspaceId, accountId, occurredAt: "2026-09-01", splits: [] }),
      (error: unknown) => isValidationError(error, "uncategorized_transaction"),
    );
  });

  it("rejects income (null category) mixed into a multi-split transaction", async () => {
    await assert.rejects(
      () =>
        createTransaction(pool, {
          workspaceId,
          accountId,
          occurredAt: "2026-09-01",
          splits: [
            { categoryId: null, amountCents: 1000 },
            { categoryId, amountCents: -1000 },
          ],
        }),
      (error: unknown) => isValidationError(error, "unsupported_transaction"),
    );
  });

  it("rejects splits that do not add up to the given total", async () => {
    await assert.rejects(
      () =>
        createTransaction(pool, {
          workspaceId,
          accountId,
          occurredAt: "2026-09-01",
          amountCents: -5000,
          splits: [{ categoryId, amountCents: -4000 }],
        }),
      (error: unknown) => isValidationError(error, "split_mismatch"),
    );
  });

  it("lists every transaction of an account, oldest first", async () => {
    const transactions = await listTransactionsForAccount(pool, workspaceId, accountId);
    assert.ok(transactions.length >= 4);
    const dates = transactions.map((t) => t.occurredAt);
    const sorted = [...dates].sort();
    assert.deepEqual(dates, sorted);
  });

  it("updates payee, memo and status without touching splits", async () => {
    const created = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-03",
      splits: [{ categoryId, amountCents: -100 }],
    });

    const updated = await updateTransaction(pool, workspaceId, created.id, { payee: "New payee", status: "cleared" });
    assert.notEqual(updated, "not_found");
    assert.notEqual(updated, "reconciled");
    if (typeof updated !== "string") {
      assert.equal(updated.payee, "New payee");
      assert.equal(updated.status, "cleared");
      assert.equal(updated.splits.length, 1);
      assert.equal(updated.splits[0]?.categoryId, categoryId);
    }
  });

  it("replaces splits entirely when given", async () => {
    const created = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-04",
      splits: [{ categoryId, amountCents: -100 }],
    });

    const updated = await updateTransaction(pool, workspaceId, created.id, {
      splits: [{ categoryId: otherCategoryId, amountCents: -100 }],
    });
    if (typeof updated !== "string") {
      assert.equal(updated.splits.length, 1);
      assert.equal(updated.splits[0]?.categoryId, otherCategoryId);
    } else {
      assert.fail(`expected a record, got "${updated}"`);
    }
  });

  it("refuses to update a reconciled transaction", async () => {
    const created = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-05",
      status: "reconciled",
      splits: [{ categoryId, amountCents: -100 }],
    });

    const result = await updateTransaction(pool, workspaceId, created.id, { payee: "Too late" });
    assert.equal(result, "reconciled");
  });

  it("rejects a direct status update to reconciled, outside the dedicated reconciliation flow (#32)", async () => {
    const created = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-06",
      status: "cleared",
      splits: [{ categoryId, amountCents: -100 }],
    });

    await assert.rejects(
      () => updateTransaction(pool, workspaceId, created.id, { status: "reconciled" }),
      (error: unknown) => isValidationError(error, "direct_reconciliation_not_allowed"),
    );
  });

  it("updating an unknown transaction reports not_found", async () => {
    const result = await updateTransaction(pool, workspaceId, randomUUID(), { payee: "Nobody" });
    assert.equal(result, "not_found");
  });

  it("creates a transfer as two linked transactions, opposite signed amounts", async () => {
    const transfer = await createTransfer(pool, {
      workspaceId,
      sourceAccountId: accountId,
      destinationAccountId: savingsAccountId,
      occurredAt: "2026-09-10",
      amountCents: 5000,
    });
    assert.equal(transfer.source.accountId, accountId);
    assert.equal(transfer.source.transferId, transfer.destination.id);
    assert.equal(transfer.source.splits[0]?.categoryId, null);
    assert.equal(transfer.source.splits[0]?.amountCents, -5000);

    assert.equal(transfer.destination.accountId, savingsAccountId);
    assert.equal(transfer.destination.transferId, transfer.source.id);
    assert.equal(transfer.destination.splits[0]?.amountCents, 5000);
  });

  it("creates a cash-to-card transfer the same way, no special-casing", async () => {
    const transfer = await createTransfer(pool, {
      workspaceId,
      sourceAccountId: accountId,
      destinationAccountId: creditCardAccountId,
      occurredAt: "2026-09-11",
      amountCents: 2000,
    });
    assert.equal(transfer.destination.accountId, creditCardAccountId);
    assert.equal(transfer.destination.splits[0]?.amountCents, 2000);
  });

  it("rejects a transfer between two on-budget credit cards", async () => {
    await assert.rejects(
      () =>
        createTransfer(pool, {
          workspaceId,
          sourceAccountId: creditCardAccountId,
          destinationAccountId: otherCreditCardAccountId,
          occurredAt: "2026-09-12",
          amountCents: 1000,
        }),
      (error: unknown) => isValidationError(error, "unsupported_transaction"),
    );
  });

  it("rejects a transfer to the same account", async () => {
    await assert.rejects(
      () =>
        createTransfer(pool, {
          workspaceId,
          sourceAccountId: accountId,
          destinationAccountId: accountId,
          occurredAt: "2026-09-12",
          amountCents: 1000,
        }),
      (error: unknown) => isValidationError(error, "duplicate_account"),
    );
  });

  it("rejects a transfer naming an unknown account", async () => {
    await assert.rejects(
      () =>
        createTransfer(pool, {
          workspaceId,
          sourceAccountId: accountId,
          destinationAccountId: randomUUID(),
          occurredAt: "2026-09-12",
          amountCents: 1000,
        }),
      (error: unknown) => isValidationError(error, "unknown_account"),
    );
  });

  it("rejects a non-positive transfer amount", async () => {
    await assert.rejects(
      () =>
        createTransfer(pool, {
          workspaceId,
          sourceAccountId: accountId,
          destinationAccountId: savingsAccountId,
          occurredAt: "2026-09-12",
          amountCents: 0,
        }),
      (error: unknown) => isValidationError(error, "invalid_amount"),
    );
  });

  it("deleting one side of a transfer sets the other's transferId to null", async () => {
    const transfer = await createTransfer(pool, {
      workspaceId,
      sourceAccountId: accountId,
      destinationAccountId: savingsAccountId,
      occurredAt: "2026-09-13",
      amountCents: 750,
    });

    await pool.query("DELETE FROM transactions WHERE id = $1", [transfer.source.id]);

    const destination = await listTransactionsForAccount(pool, workspaceId, savingsAccountId);
    const remaining = destination.find((t) => t.id === transfer.destination.id);
    assert.equal(remaining?.transferId, null);
  });

  it("queues a budget-recompute job in the same transaction as the write that triggers it, and rolls both back together (#35)", async () => {
    const queue = createPostgresQueueDriver(queueConnectionString(databaseUrl), pool);
    await queue.start();
    const received: unknown[] = [];
    await queue.work("budget-recompute", async (data) => {
      received.push(data);
    });

    // Committed: the transaction and its job both persist.
    const client = await pool.connect();
    let committedId: string | undefined;
    try {
      await client.query("BEGIN");
      const committed = await createTransaction(
        client,
        { workspaceId, accountId, occurredAt: "2026-09-14", splits: [{ categoryId, amountCents: -100 }] },
        queue,
      );
      committedId = committed.id;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await waitUntil(() => received.some((d) => (d as { transactionId: string }).transactionId === committedId));

    // Rolled back: neither the transaction row nor its job survive.
    const rollbackClient = await pool.connect();
    let rolledBackId: string | undefined;
    try {
      await rollbackClient.query("BEGIN");
      const rolledBack = await createTransaction(
        rollbackClient,
        { workspaceId, accountId, occurredAt: "2026-12-15", splits: [{ categoryId, amountCents: -200 }] },
        queue,
      );
      rolledBackId = rolledBack.id;
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000)); // long enough for at least one poll, had the job survived
    assert.ok(
      !received.some((d) => (d as { transactionId: string }).transactionId === rolledBackId),
      "a job queued inside a rolled-back transaction must never have been delivered",
    );
    const rolledBackTransaction = await pool.query("SELECT 1 FROM transactions WHERE id = $1", [rolledBackId]);
    assert.equal(rolledBackTransaction.rows.length, 0, "the rolled-back transaction row must not exist either");

    await queue.stop();
  });
});
