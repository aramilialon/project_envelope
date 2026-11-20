/**
 * Migration 0032 (#513) moves `change_log`'s key to `(workspace_id, id)` and adds the `outcome`
 * a retry answers with, filled in for rows recorded before it. This applies 0032 on a scratch
 * database that already holds change_log rows.
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

const MIGRATION = "0032_change_log_workspace_key.sql";

describe("migration 0032 on a database with existing change_log rows", () => {
  let scratch: IsolatedDatabase;
  let scratchPool: DbPool;
  let migrationsDir: string;

  before(async () => {
    scratch = await createIsolatedDatabase(databaseUrl);
    scratchPool = createPool(scratch.databaseUrl);

    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-m0032-"));
    for (const file of await readdir(DEFAULT_MIGRATIONS_DIR)) {
      if (file.endsWith(".sql") && file < MIGRATION) {
        await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(migrationsDir, file));
      }
    }
  });

  after(async () => {
    await scratchPool.end();
    await scratch.drop();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it("keys change_log on (workspace_id, id) and fills in each existing row's outcome", async () => {
    await runMigrations(scratchPool, migrationsDir);
    const workspaceId = randomUUID();
    await scratchPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Old', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const entityId = randomUUID();
    const insert = (id: string, physical: number, receivedAt: string, entity = entityId) =>
      scratchPool.query(
        `INSERT INTO change_log (id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, received_at)
         VALUES ($1, $2, $3, 'transactions.memo', $4, 0, 'd', '"v"', $5)`,
        [id, workspaceId, entity, physical, receivedAt],
      );
    const first = randomUUID();
    const later = randomUUID();
    const arrivedLate = randomUUID();
    await insert(first, 1000, "2026-01-01T00:00:00Z");
    await insert(later, 2000, "2026-01-02T00:00:00Z");
    await insert(arrivedLate, 1500, "2026-01-03T00:00:00Z");
    // One request, sent in clock order by its device: both share received_at, and both applied.
    const batchEntityId = randomUUID();
    const batchFirst = randomUUID();
    const batchSecond = randomUUID();
    await insert(batchFirst, 1000, "2026-01-04T00:00:00Z", batchEntityId);
    await insert(batchSecond, 2000, "2026-01-04T00:00:00Z", batchEntityId);

    await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(migrationsDir, MIGRATION));
    assert.deepEqual(await runMigrations(scratchPool, migrationsDir), [MIGRATION]);

    const { rows } = await scratchPool.query<{ id: string; outcome: string }>("SELECT id, outcome FROM change_log");
    const outcomeOf = (id: string) => rows.find((row) => row.id === id)?.outcome;
    assert.equal(outcomeOf(first), "applied");
    assert.equal(outcomeOf(later), "applied");
    assert.equal(outcomeOf(arrivedLate), "stale");
    assert.equal(outcomeOf(batchFirst), "applied", "an earlier change of the same request is not stale against a later one");
    assert.equal(outcomeOf(batchSecond), "applied");

    const { rows: key } = await scratchPool.query<{ columns: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'change_log'::regclass AND c.contype = 'p'`,
    );
    assert.deepEqual(key[0]?.columns, ["workspace_id", "id"]);

    const otherWorkspaceId = randomUUID();
    await scratchPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'UTC')", [
      otherWorkspaceId,
    ]);
    await scratchPool.query(
      `INSERT INTO change_log (id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, outcome)
       VALUES ($1, $2, $3, 'transactions.memo', 1, 0, 'd', '"w"', 'applied')`,
      [first, otherWorkspaceId, randomUUID()],
    );
    const { rows: shared } = await scratchPool.query("SELECT 1 FROM change_log WHERE id = $1", [first]);
    assert.equal(shared.length, 2, "the same change id is now allowed once per workspace");
  });
});
