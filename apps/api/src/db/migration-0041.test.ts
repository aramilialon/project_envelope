/**
 * Migration 0041 (#712) deletes the stored splits whose two figures are equal (1:1, 3:3), which
 * change nothing, and adds the rule to the table. This applies 0041 on a scratch database holding
 * such rows, next to a real split it must leave alone, on an open and a closed account.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { computePositions, type PositionTrade } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { loadPositionTrades } from "../trades/repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const MIGRATION = "0041_no_identity_splits.sql";
const UNIT = 100_000_000;
const EURO = 1_000_000;

describe("migration 0041 on a database with 1:1 splits", () => {
  let scratch: IsolatedDatabase;
  let pool: DbPool;
  let migrationsDir: string;

  before(async () => {
    scratch = await createIsolatedDatabase(databaseUrl);
    pool = createPool(scratch.databaseUrl);
    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-m0041-"));
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

  async function instrument(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO instruments (ticker, exchange, name, type, currency)
       VALUES ($1, 'XMIL', 'Test instrument', 'stock', 'EUR') RETURNING id`,
      [`T${randomBytes(6).toString("hex").toUpperCase()}`],
    );
    return rows[0]!.id;
  }

  interface Holding {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly portfolioId: string;
  }

  async function holding(): Promise<Holding> {
    const workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'W', 'EUR', 'Europe/Rome')", [workspaceId]);
    const { rows: portfolios } = await pool.query<{ id: string }>(
      "INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'P') RETURNING id",
      [workspaceId],
    );
    const { rows: accounts } = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'brokerage', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    return { workspaceId, accountId: accounts[0]!.id, portfolioId: portfolios[0]!.id };
  }

  async function trade(at: Holding, instrumentId: string, type: "buy" | "sell", tradeDate: string, quantityE8: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trades (workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, quantity_e8, price_e6, gross_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [at.workspaceId, at.accountId, at.portfolioId, instrumentId, type, tradeDate, quantityE8, 10 * EURO, Math.round((quantityE8 / UNIT) * 1_000)],
    );
    return rows[0]!.id;
  }

  async function split(at: Holding, instrumentId: string, tradeDate: string, splitFrom: number, splitTo: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trades (workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, split_from, split_to)
       VALUES ($1, $2, $3, $4, 'split', $5, $6, $7) RETURNING id`,
      [at.workspaceId, at.accountId, at.portfolioId, instrumentId, tradeDate, splitFrom, splitTo],
    );
    return rows[0]!.id;
  }

  async function replayed(at: Holding): Promise<PositionTrade[]> {
    const client = await pool.connect();
    try {
      return await loadPositionTrades(client, at.workspaceId, { accountId: at.accountId });
    } finally {
      client.release();
    }
  }

  async function tradeIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM trades ORDER BY id");
    return rows.map((row) => row.id);
  }

  it("deletes only the splits whose figures are equal, on closed accounts too, and changes no position", async () => {
    await runMigrations(pool, migrationsDir);
    const stock = await instrument();
    const fraction = await instrument();

    // Buy 10, a 1:1 split, sell 4; a real 1:2 split later; a 3:3 split of 0.33333333 units.
    const open = await holding();
    await trade(open, stock, "buy", "2026-01-05", 10 * UNIT);
    const identity = await split(open, stock, "2026-02-02", 1, 1);
    await trade(open, stock, "sell", "2026-03-02", 4 * UNIT);
    const real = await split(open, stock, "2026-04-01", 1, 2);
    await trade(open, fraction, "buy", "2026-01-05", 33_333_333);
    const nonReduced = await split(open, fraction, "2026-02-02", 3, 3);

    const closed = await holding();
    await trade(closed, stock, "buy", "2026-01-05", 2 * UNIT);
    await trade(closed, stock, "sell", "2026-01-20", 2 * UNIT);
    const closedIdentity = await split(closed, stock, "2026-02-02", 7, 7);
    await pool.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [closed.accountId]);

    const openBefore = computePositions(await replayed(open));
    const closedBefore = computePositions(await replayed(closed));
    const before = await tradeIds();

    await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(migrationsDir, MIGRATION));
    assert.deepEqual(await runMigrations(pool, migrationsDir), [MIGRATION]);

    const deleted = new Set([identity, nonReduced, closedIdentity]);
    assert.deepEqual(await tradeIds(), before.filter((id) => !deleted.has(id)), "only the identity splits are deleted");
    assert.ok((await tradeIds()).includes(real), "a real split stays");

    // Every position, cost and realized gain is as it was.
    const openAfter = computePositions(await replayed(open));
    assert.deepEqual(openAfter, openBefore);
    const stockPosition = openAfter.portfolios.find((position) => position.instrumentId === stock);
    assert.equal(stockPosition?.quantity, 12 * UNIT, "10 bought, 4 sold, then 1:2");
    const fractionPosition = openAfter.portfolios.find((position) => position.instrumentId === fraction);
    assert.equal(fractionPosition?.quantity, 33_333_333);
    // The closed account held 0 at its split: its zero row was the split row's alone, and goes.
    const closedAfter = computePositions(await replayed(closed));
    assert.deepEqual(
      closedAfter.portfolios.map((position) => position.quantity),
      closedBefore.portfolios.map((position) => position.quantity),
    );

    // The closed-account guard is back on, and the table refuses a new identity split.
    const { rows: trigger } = await pool.query<{ tgenabled: string }>("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trades_refuse_closed_account'");
    assert.equal(trigger[0]?.tgenabled, "O");
    await assert.rejects(
      split(open, stock, "2026-05-04", 2, 2),
      (error: { code?: string; constraint?: string }) => error.code === "23514" && error.constraint === "trades_split_identity_check",
    );
    await split(open, stock, "2026-05-04", 2, 4);
  });
});
