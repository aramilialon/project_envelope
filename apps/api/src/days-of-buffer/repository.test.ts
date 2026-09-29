import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createTransaction, createTransfer } from "../transactions/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { getCurrentDate, getDaysOfBuffer } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("days of buffer repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let checkingAccountId: string;
  let brokerAccountId: string;
  let categoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'America/Los_Angeles')",
      [workspaceId],
    );
    const checking = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    checkingAccountId = checking.rows[0]!.id;
    const broker = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'checking', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    brokerAccountId = broker.rows[0]!.id;
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

  it("computes the weighted age of real transactions, first in first out", async () => {
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-08-01",
      splits: [{ categoryId: null, amountCents: 10_000 }],
    });
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-08-05",
      splits: [{ categoryId, amountCents: -4_000 }],
    });
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-08-10",
      splits: [{ categoryId, amountCents: -6_000 }],
    });

    const result = await getDaysOfBuffer(pool, workspaceId, "2026-08-10");
    assert.equal(result, (4 * 4_000 + 9 * 6_000) / 10_000); // 7.0
  });

  it("does not count a transfer to an off-budget account's own leg, but does count the on-budget side", async () => {
    await createTransfer(pool, {
      workspaceId,
      sourceAccountId: checkingAccountId,
      destinationAccountId: brokerAccountId,
      occurredAt: "2026-08-15",
      amountCents: 1_000,
    });

    const result = await getDaysOfBuffer(pool, workspaceId, "2026-08-15");
    // The €10 leaving to the broker is a real outflow of the on-budget side, but the
    // FIFO queue is already empty by then (the whole €100 inflow was spent on Aug 5
    // and Aug 10), so it is treated as instant (age 0) rather than guessed at.
    assert.equal(result, (4 * 4_000 + 9 * 6_000 + 0 * 1_000) / (10_000 + 1_000));
  });

  it("reports today in the workspace's own time zone", async () => {
    const today = await getCurrentDate(pool, workspaceId);
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  });
});
