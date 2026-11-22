/**
 * Migration 0037 (#706) moves a credit card's "Starting balance" transaction written before #706
 * (stored at `now()`, the moment the card was created) to midnight of its day in the workspace's
 * time zone, so it comes first on that day. This applies 0037 on a scratch database holding rows
 * written the old way, next to rows it must leave alone.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { listTransactionsForAccount } from "../transactions/repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const MIGRATION = "0037_card_starting_balance_start_of_day.sql";

interface Snapshot {
  readonly id: string;
  readonly occurred_at: string;
  readonly day: string;
}

describe("migration 0037 on a database with starting balances stored at their creation time", () => {
  let scratch: IsolatedDatabase;
  let pool: DbPool;
  let migrationsDir: string;

  before(async () => {
    scratch = await createIsolatedDatabase(databaseUrl);
    pool = createPool(scratch.databaseUrl);

    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-m0037-"));
    for (const file of await readdir(DEFAULT_MIGRATIONS_DIR)) {
      if (file.endsWith(".sql") && file < MIGRATION) {
        await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(migrationsDir, file));
      }
    }
  });

  after(async () => {
    await pool.end();
    await scratch.drop();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  async function workspace(timeZone: string): Promise<{ id: string; groupId: string }> {
    const id = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'W', 'EUR', $2)", [id, timeZone]);
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'G', 1) RETURNING id",
      [id],
    );
    return { id, groupId: rows[0]!.id };
  }

  async function category(ws: { id: string; groupId: string }, name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, $3, 1) RETURNING id",
      [ws.id, ws.groupId, name],
    );
    return rows[0]!.id;
  }

  /** An on-budget card with its payment category, as `createAccount` makes one. */
  async function card(ws: { id: string; groupId: string }, name: string): Promise<{ id: string; paymentCategoryId: string }> {
    const paymentCategoryId = await category(ws, `${name} payment`);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget, payment_category_id)
       VALUES ($1, $2, 'credit_card', 'EUR', true, $3) RETURNING id`,
      [ws.id, name, paymentCategoryId],
    );
    return { id: rows[0]!.id, paymentCategoryId };
  }

  async function transaction(
    workspaceId: string,
    accountId: string,
    occurredAt: string,
    createdAt: string,
    splits: ReadonlyArray<{ categoryId: string | null; amountCents: number }>,
    payee = "Starting balance",
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO transactions (workspace_id, account_id, occurred_at, created_at, payee, status)
       VALUES ($1, $2, $3, $4, $5, 'cleared') RETURNING id`,
      [workspaceId, accountId, occurredAt, createdAt, payee],
    );
    const id = rows[0]!.id;
    for (const split of splits) {
      await pool.query("INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, $4)", [
        workspaceId,
        id,
        split.categoryId,
        split.amountCents,
      ]);
    }
    return id;
  }

  async function snapshot(): Promise<Snapshot[]> {
    const { rows } = await pool.query<Snapshot>(
      `SELECT t.id, to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
              to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS day
       FROM transactions t JOIN workspaces w ON w.id = t.workspace_id ORDER BY t.id`,
    );
    return rows;
  }

  /** Each row's payee and the card's balance after it, in the register's order (oldest first). */
  async function register(workspaceId: string, accountId: string): Promise<Array<[string | null, number]>> {
    let balance = 0;
    return (await listTransactionsForAccount(pool, workspaceId, accountId)).map((t) => {
      balance += t.splits.reduce((sum, s) => sum + s.amountCents, 0);
      return [t.payee, balance];
    });
  }

  it("moves only the old starting balances to midnight of their day, keeping the day, and is idempotent", async () => {
    await runMigrations(pool, migrationsDir);

    // New York, in November: UTC−5, so midnight is 05:00Z.
    const ny = await workspace("America/New_York");
    const groceries = await category(ny, "Groceries");

    // The issue's case: a card created owing €500 at 14:30 local time, and a €45.67 purchase dated
    // the same day (stored at local midnight, created later).
    const visa = await card(ny, "Visa");
    const visaStart = await transaction(ny.id, visa.id, "2026-11-10T19:30:00.123456Z", "2026-11-10T19:30:00.123456Z", [
      { categoryId: visa.paymentCategoryId, amountCents: -50_000 },
    ]);
    await transaction(ny.id, visa.id, "2026-11-10T05:00:00Z", "2026-11-10T20:00:00Z", [{ categoryId: groceries, amountCents: -4_567 }], "Grocer");

    // Created at 21:30 local time, already the next day in UTC: it stays on its local day.
    const amex = await card(ny, "Amex");
    const amexStart = await transaction(ny.id, amex.id, "2026-11-11T02:30:00.5Z", "2026-11-11T02:30:00.5Z", [
      { categoryId: amex.paymentCategoryId, amountCents: -12_345 },
    ]);

    // A closed card's starting balance is moved as well (the closed-account guard is bypassed).
    const closed = await card(ny, "Closed");
    const closedStart = await transaction(ny.id, closed.id, "2026-11-12T15:00:00.25Z", "2026-11-12T15:00:00.25Z", [
      { categoryId: closed.paymentCategoryId, amountCents: -1_000 },
    ]);
    await pool.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [closed.id]);

    // Rows to leave alone:
    // a payment-category row whose time is not its creation time (its date was set by someone);
    const dated = await transaction(ny.id, amex.id, "2026-11-05T12:00:00Z", "2026-11-13T10:00:00Z", [
      { categoryId: amex.paymentCategoryId, amountCents: -1 },
    ]);
    // a card row stored at its creation time but spent on an ordinary category;
    const spending = await transaction(ny.id, visa.id, "2026-11-14T16:00:00.1Z", "2026-11-14T16:00:00.1Z", [
      { categoryId: groceries, amountCents: -2_000 },
    ], "Grocer");
    // a payment-category row with two splits;
    const twoSplits = await transaction(ny.id, visa.id, "2026-11-15T16:00:00.2Z", "2026-11-15T16:00:00.2Z", [
      { categoryId: visa.paymentCategoryId, amountCents: -300 },
      { categoryId: groceries, amountCents: -200 },
    ]);
    // a cash account's row stored at its creation time.
    const { rows: checkingRows } = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Checking', 'checking', 'EUR', true) RETURNING id",
      [ny.id],
    );
    const income = await transaction(ny.id, checkingRows[0]!.id, "2026-11-10T19:30:00.3Z", "2026-11-10T19:30:00.3Z", [
      { categoryId: null, amountCents: 100_000 },
    ], "Salary");

    // Rome, in November: UTC+1. Created at 00:30 local time on 11 November, still 10 November in UTC.
    const rome = await workspace("Europe/Rome");
    const romeCard = await card(rome, "Carta");
    const romeStart = await transaction(rome.id, romeCard.id, "2026-11-10T23:30:00.7Z", "2026-11-10T23:30:00.7Z", [
      { categoryId: romeCard.paymentCategoryId, amountCents: -70_000 },
    ]);

    // Before: the purchase sorts first, and runs as if the card owed nothing yet.
    assert.deepEqual((await register(ny.id, visa.id)).slice(0, 2), [
      ["Grocer", -4_567],
      ["Starting balance", -54_567],
    ]);
    const before = await snapshot();

    await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(migrationsDir, MIGRATION));
    assert.deepEqual(await runMigrations(pool, migrationsDir), [MIGRATION]);

    const afterRows = await snapshot();
    const occurredAt = (rows: Snapshot[], id: string) => rows.find((row) => row.id === id)?.occurred_at;
    assert.equal(occurredAt(afterRows, visaStart), "2026-11-10T05:00:00.000000Z");
    assert.equal(occurredAt(afterRows, amexStart), "2026-11-10T05:00:00.000000Z");
    assert.equal(occurredAt(afterRows, closedStart), "2026-11-12T05:00:00.000000Z");
    assert.equal(occurredAt(afterRows, romeStart), "2026-11-10T23:00:00.000000Z");
    for (const untouched of [dated, spending, twoSplits, income]) {
      assert.equal(occurredAt(afterRows, untouched), occurredAt(before, untouched), "a row that is not an old starting balance is left alone");
    }
    assert.deepEqual(
      afterRows.map((row) => [row.id, row.day]),
      before.map((row) => [row.id, row.day]),
      "every row keeps its day in its workspace's time zone",
    );

    // After: the starting balance comes first, and the purchase runs from the debt it starts with.
    assert.deepEqual((await register(ny.id, visa.id)).slice(0, 2), [
      ["Starting balance", -50_000],
      ["Grocer", -54_567],
    ]);

    // The closed-account guard is back on.
    const { rows: trigger } = await pool.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'transactions_refuse_closed_account'",
    );
    assert.equal(trigger[0]?.tgenabled, "O");
    await assert.rejects(
      pool.query("UPDATE transactions SET memo = 'x' WHERE id = $1", [closedStart]),
      (error: { constraint?: string }) => error.constraint === "account_closed",
    );

    // Running it again changes nothing.
    const sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.deepEqual(await snapshot(), afterRows);
  });
});
