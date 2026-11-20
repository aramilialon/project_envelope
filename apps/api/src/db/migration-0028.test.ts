/**
 * Migration 0028 (#508) adds `accounts_workspace_id_id_key` only when it is missing: another
 * migration numbered after it may add the same key and be applied to an existing database
 * first. This applies 0028 on a scratch database where the key already exists.
 */
import assert from "node:assert/strict";
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

const MIGRATION = "0028_tax_regime.sql";

describe("migration 0028 on a database that already has accounts_workspace_id_id_key", () => {
  let scratch: IsolatedDatabase;
  let scratchPool: DbPool;
  let migrationsDir: string;

  before(async () => {
    scratch = await createIsolatedDatabase(databaseUrl);
    scratchPool = createPool(scratch.databaseUrl);

    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-m0028-"));
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

  it("applies cleanly, keeping the one existing key", async () => {
    await runMigrations(scratchPool, migrationsDir);
    await scratchPool.query("ALTER TABLE accounts ADD CONSTRAINT accounts_workspace_id_id_key UNIQUE (workspace_id, id)");

    await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(migrationsDir, MIGRATION));
    assert.deepEqual(await runMigrations(scratchPool, migrationsDir), [MIGRATION]);

    const { rows } = await scratchPool.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND contype = 'u'",
    );
    assert.deepEqual(rows, [{ conname: "accounts_workspace_id_id_key" }]);
    const table = await scratchPool.query("SELECT to_regclass('account_tax_regimes') IS NOT NULL AS exists");
    assert.equal(table.rows[0].exists, true);
  });
});
