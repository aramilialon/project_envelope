/**
 * Migration 0038 (#596) gives the untimed trades that the new replay order (an untimed trade at the
 * start of its date in the workspace's time zone, no longer at midnight UTC) would move past a
 * trade of the same instrument and date the time they sorted at until then, midnight UTC of their
 * date. This applies 0038 on a scratch database holding such histories, next to trades it must
 * leave alone.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { computePositions, isValidationError, type PositionTrade } from "@envelope/core";

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

const MIGRATION = "0038_untimed_trades_keep_their_order.sql";
const UNIT = 100_000_000;
const EURO = 1_000_000;

interface Snapshot {
  readonly id: string;
  readonly occurred_at: string | null;
}

describe("migration 0038 on a database with untimed trades sorted at midnight UTC", () => {
  let scratch: IsolatedDatabase;
  let pool: DbPool;
  let migrationsDir: string;

  before(async () => {
    scratch = await createIsolatedDatabase(databaseUrl);
    pool = createPool(scratch.databaseUrl);

    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-m0038-"));
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

  interface Workspace {
    readonly id: string;
    readonly portfolioId: string;
  }

  async function workspace(timeZone: string): Promise<Workspace> {
    const id = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'W', 'EUR', $2)", [id, timeZone]);
    const { rows } = await pool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'P') RETURNING id", [id]);
    return { id, portfolioId: rows[0]!.id };
  }

  async function broker(ws: Workspace): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'brokerage', 'EUR', false) RETURNING id",
      [ws.id],
    );
    return rows[0]!.id;
  }

  async function instrument(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO instruments (ticker, exchange, name, type, currency)
       VALUES ($1, 'XMIL', 'Test instrument', 'fund', 'EUR') RETURNING id`,
      [`T${randomBytes(6).toString("hex").toUpperCase()}`],
    );
    return rows[0]!.id;
  }

  /** A buy or a sale of `units` at €10, at `occurredAt` or with no time. */
  async function trade(
    ws: Workspace,
    accountId: string,
    instrumentId: string,
    type: "buy" | "sell",
    tradeDate: string,
    occurredAt: string | null,
    units: number,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trades (workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, occurred_at,
                           quantity_e8, price_e6, gross_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [ws.id, accountId, ws.portfolioId, instrumentId, type, tradeDate, occurredAt, units * UNIT, 10 * EURO, units * 1_000],
    );
    return rows[0]!.id;
  }

  /** A fee on the whole account, with no instrument and no time. */
  async function fee(ws: Workspace, accountId: string, tradeDate: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trades (workspace_id, account_id, portfolio_id, type, trade_date, fees_cents)
       VALUES ($1, $2, $3, 'fee', $4, 100) RETURNING id`,
      [ws.id, accountId, ws.portfolioId, tradeDate],
    );
    return rows[0]!.id;
  }

  async function snapshot(): Promise<Snapshot[]> {
    const { rows } = await pool.query<Snapshot>(
      `SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at FROM trades ORDER BY id`,
    );
    return rows;
  }

  /** The account's trades as the replay reads them now: an untimed trade at the start of its local date. */
  async function replayed(ws: Workspace, accountId: string): Promise<PositionTrade[]> {
    const client = await pool.connect();
    try {
      return await loadPositionTrades(client, ws.id, { accountId });
    } finally {
      client.release();
    }
  }

  it("gives only the untimed trades a new time would reorder their time until now, so every history replays as it did", async () => {
    await runMigrations(pool, migrationsDir);

    // Rome in January (UTC+1): midnight local is 23:00Z the day before, midnight UTC 01:00 local.
    const rome = await workspace("Europe/Rome");
    const account = await broker(rome);
    const etf = await instrument();
    // The issue's case: a buy timed at 00:30 local (23:30Z on the 11th) and an untimed sale of the
    // same date. It sorted after the buy (at 00:00Z); at local midnight (23:00Z) it would come first
    // and the replay would refuse it.
    await trade(rome, account, etf, "buy", "2026-01-05", null, 10);
    await trade(rome, account, etf, "buy", "2026-01-12", "2026-01-11T23:30:00Z", 4);
    const sale = await trade(rome, account, etf, "sell", "2026-01-12", null, 12);
    // Its other untimed trades that day move too, keeping their place against the sale.
    const otherSale = await trade(rome, account, etf, "sell", "2026-01-12", null, 1);
    // Left alone: an untimed trade of the same instrument on another date,
    const otherDate = await trade(rome, account, etf, "sell", "2026-01-13", null, 1);
    // an untimed trade of another instrument on that date,
    const bond = await instrument();
    await trade(rome, account, bond, "buy", "2026-01-11", null, 5);
    const otherInstrument = await trade(rome, account, bond, "sell", "2026-01-12", null, 1);
    // and a fee with no instrument on that date.
    const accountFee = await fee(rome, account, "2026-01-12");

    // Rome, a timed trade after midnight UTC: untimed trades sort before it either way.
    const later = await instrument();
    const laterUntimed = await trade(rome, account, later, "buy", "2026-01-20", null, 2);
    await trade(rome, account, later, "sell", "2026-01-20", "2026-01-20T09:00:00Z", 1);

    // Another workspace holding the same instrument, with an untimed trade on the same date but no
    // timed one in the window.
    const milan = await workspace("Europe/Rome");
    const milanAccount = await broker(milan);
    const otherWorkspace = await trade(milan, milanAccount, etf, "buy", "2026-01-12", null, 3);

    // New York (UTC−5): a time is always on its date there, after midnight UTC, and an untimed
    // trade already sorted before it.
    const newYork = await workspace("America/New_York");
    const nyAccount = await broker(newYork);
    const nyBuy = await trade(newYork, nyAccount, etf, "buy", "2026-01-12", null, 2);
    await trade(newYork, nyAccount, etf, "sell", "2026-01-12", "2026-01-12T05:30:00Z", 1);

    // London (UTC+0 in January), with a time stored before midnight of its date there (recorded
    // under another time zone): it came before the untimed trade, and still does.
    const london = await workspace("Europe/London");
    const londonAccount = await broker(london);
    await trade(london, londonAccount, etf, "buy", "2026-01-12", "2026-01-11T23:30:00Z", 2);
    const londonUntimed = await trade(london, londonAccount, etf, "sell", "2026-01-12", null, 1);

    // A closed account with the issue's case: repaired as well.
    const closedWs = await workspace("Europe/Rome");
    const closed = await broker(closedWs);
    await trade(closedWs, closed, etf, "buy", "2026-03-02", "2026-03-01T23:30:00Z", 2);
    const closedSale = await trade(closedWs, closed, etf, "sell", "2026-03-02", null, 2);
    await pool.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [closed]);

    // Before: the replay in the new order refuses the history...
    await assert.rejects(replayed(rome, account).then(computePositions), (error) => isValidationError(error, "insufficient_quantity"));
    await assert.rejects(replayed(closedWs, closed).then(computePositions), (error) => isValidationError(error, "insufficient_quantity"));
    // ...that the old order accepted: its positions, with the untimed trades at midnight UTC.
    const { rows: untimedRows } = await pool.query<{ id: string }>("SELECT id FROM trades WHERE occurred_at IS NULL");
    const untimed = new Set(untimedRows.map((row) => row.id));
    const oldOrder = (trades: PositionTrade[]) =>
      trades.map((t) => (untimed.has(t.id) ? { ...t, occurredAt: `${t.date}T00:00:00.000Z` } : t));
    const positionsBefore = computePositions(oldOrder(await replayed(rome, account)));
    const closedBefore = computePositions(oldOrder(await replayed(closedWs, closed)));
    const before = await snapshot();

    await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(migrationsDir, MIGRATION));
    assert.deepEqual(await runMigrations(pool, migrationsDir), [MIGRATION]);

    const afterRows = await snapshot();
    const occurredAt = (rows: Snapshot[], id: string) => rows.find((row) => row.id === id)?.occurred_at;
    assert.equal(occurredAt(afterRows, sale), "2026-01-12T00:00:00Z");
    assert.equal(occurredAt(afterRows, otherSale), "2026-01-12T00:00:00Z");
    assert.equal(occurredAt(afterRows, closedSale), "2026-03-02T00:00:00Z");
    for (const [name, id] of Object.entries({ otherDate, otherInstrument, accountFee, laterUntimed, otherWorkspace, nyBuy, londonUntimed })) {
      assert.equal(occurredAt(afterRows, id), null, `${name} stays untimed`);
    }
    const moved = new Set([sale, otherSale, closedSale]);
    assert.deepEqual(
      afterRows.filter((row) => !moved.has(row.id)),
      before.filter((row) => !moved.has(row.id)),
      "no other trade changes",
    );

    // After: the history replays in the new order, with the positions it had.
    assert.deepEqual(computePositions(await replayed(rome, account)), positionsBefore);
    assert.deepEqual(computePositions(await replayed(closedWs, closed)), closedBefore);

    // The closed-account guard is back on.
    const { rows: trigger } = await pool.query<{ tgenabled: string }>("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trades_refuse_closed_account'");
    assert.equal(trigger[0]?.tgenabled, "O");
    await assert.rejects(
      pool.query("UPDATE trades SET memo = 'x' WHERE id = $1", [closedSale]),
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
