import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createTransaction, listTransactionsForAccount, updateTransaction } from "./repository.ts";

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
  let categoryId: string;
  let otherCategoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

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

  it("updating an unknown transaction reports not_found", async () => {
    const result = await updateTransaction(pool, workspaceId, randomUUID(), { payee: "Nobody" });
    assert.equal(result, "not_found");
  });
});
