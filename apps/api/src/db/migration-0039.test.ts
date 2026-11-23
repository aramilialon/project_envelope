/**
 * Migration 0039 (#559, ADR 0020) registers every assignment batch already in the ledger in the
 * new `assignment_batches` table, then makes each ledger row reference its batch. This applies 0039
 * on a scratch database holding batches of two workspaces, one id shared by both.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const MIGRATION = "0039_idempotent_creates.sql";

interface Batch {
  readonly workspace_id: string;
  readonly id: string;
  readonly request_hash: Buffer | null;
  readonly created_at: string;
}

describe("migration 0039 on a database with assignment batches", () => {
  let scratch: IsolatedDatabase;
  let pool: DbPool;
  let migrationsDir: string;

  before(async () => {
    scratch = await createIsolatedDatabase(databaseUrl);
    pool = createPool(scratch.databaseUrl);

    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-m0039-"));
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
    readonly categoryId: string;
  }

  async function workspace(): Promise<Workspace> {
    const id = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'W', 'EUR', 'Europe/Rome')", [id]);
    const { rows: group } = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [id],
    );
    const { rows: category } = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [id, group[0]!.id],
    );
    return { id, categoryId: category[0]!.id };
  }

  async function user(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("INSERT INTO users (keycloak_subject, email) VALUES ($1, $1 || '@example.test') RETURNING id", [randomUUID()]);
    return rows[0]!.id;
  }

  /** One ledger row of `batchId`, assigning €1 to the workspace's category, written at `createdAt`. */
  async function entry(ws: Workspace, author: string, batchId: string, createdAt: string): Promise<void> {
    await pool.query(
      `INSERT INTO assignment_ledger (batch_id, workspace_id, month, destination_category_id, amount_cents, author, created_at)
       VALUES ($1, $2, '2026-09-01', $3, 100, $4, $5)`,
      [batchId, ws.id, ws.categoryId, author, createdAt],
    );
  }

  async function batches(): Promise<Batch[]> {
    const { rows } = await pool.query<Batch>(
      `SELECT workspace_id, id, request_hash,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM assignment_batches ORDER BY workspace_id, id`,
    );
    return rows;
  }

  it("registers one batch per workspace and batch id, and makes every ledger row reference its own workspace's batch", async () => {
    await runMigrations(pool, migrationsDir);

    const author = await user();
    const home = await workspace();
    const other = await workspace();
    // A batch of three rows, written at different times: its batch keeps the earliest.
    const several = randomUUID();
    await entry(home, author, several, "2026-09-02T10:00:00Z");
    await entry(home, author, several, "2026-09-02T09:00:00Z");
    await entry(home, author, several, "2026-09-02T11:00:00Z");
    // A batch of one row.
    const single = randomUUID();
    await entry(home, author, single, "2026-09-03T08:00:00Z");
    // The same id in another workspace: a batch of its own there.
    await entry(other, author, several, "2026-09-05T12:00:00Z");

    await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(migrationsDir, MIGRATION));
    assert.deepEqual(await runMigrations(pool, migrationsDir), [MIGRATION]);

    const expected: Batch[] = [
      { workspace_id: home.id, id: several, request_hash: null, created_at: "2026-09-02T09:00:00Z" },
      { workspace_id: home.id, id: single, request_hash: null, created_at: "2026-09-03T08:00:00Z" },
      { workspace_id: other.id, id: several, request_hash: null, created_at: "2026-09-05T12:00:00Z" },
    ];
    const byKey = (a: Batch, b: Batch) => `${a.workspace_id}/${a.id}`.localeCompare(`${b.workspace_id}/${b.id}`);
    assert.deepEqual([...(await batches())].sort(byKey), expected.sort(byKey));

    // The ledger rows are untouched, with no position.
    const { rows: ledger } = await pool.query<{ n: number; positioned: number }>(
      "SELECT count(*)::int AS n, count(batch_position)::int AS positioned FROM assignment_ledger",
    );
    assert.deepEqual(ledger[0], { n: 5, positioned: 0 });

    // A row of a batch no workspace has registered is refused...
    const isBatchForeignKey = (error: { code?: string; constraint?: string }) =>
      error.code === "23503" && error.constraint === "assignment_ledger_batch_id_fkey";
    await assert.rejects(entry(home, author, randomUUID(), "2026-09-06T08:00:00Z"), isBatchForeignKey);
    // ...and so is one of a batch only another workspace has.
    await assert.rejects(entry(other, author, single, "2026-09-06T08:00:00Z"), isBatchForeignKey);
    // A registered batch of its own workspace is accepted.
    await entry(other, author, several, "2026-09-06T08:00:00Z");

    // Deleting a workspace still deletes its ledger rows and its batches, leaving the other's.
    await pool.query("DELETE FROM workspaces WHERE id = $1", [home.id]);
    assert.deepEqual(
      (await batches()).map((batch) => [batch.workspace_id, batch.id]),
      [[other.id, several]],
    );
    const { rows: left } = await pool.query<{ workspace_id: string; n: number }>(
      "SELECT workspace_id, count(*)::int AS n FROM assignment_ledger GROUP BY workspace_id",
    );
    assert.deepEqual(left, [{ workspace_id: other.id, n: 2 }]);
  });
});
