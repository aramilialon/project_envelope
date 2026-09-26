import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("runMigrations", () => {
  let pool: DbPool;
  let migrationsDir: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await pool.query("DROP TABLE IF EXISTS migration_smoke_test");
    // schema_migrations is also used by the real migrations in apps/api/migrations
    // (see schema.test.ts): only remove this fixture's own row, never the whole table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query("DELETE FROM schema_migrations WHERE name = '0001_create_smoke_test.sql'");
    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-migrations-"));
  });

  after(async () => {
    await pool.query("DROP TABLE IF EXISTS migration_smoke_test");
    await pool.query("DELETE FROM schema_migrations WHERE name = '0001_create_smoke_test.sql'");
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it("applies pending migrations in order and records them", async () => {
    await writeFile(
      path.join(migrationsDir, "0001_create_smoke_test.sql"),
      "CREATE TABLE migration_smoke_test (id int PRIMARY KEY);",
    );

    const applied = await runMigrations(pool, migrationsDir);

    assert.deepEqual(applied, ["0001_create_smoke_test.sql"]);
    const { rows } = await pool.query("SELECT name FROM schema_migrations WHERE name = $1", [
      "0001_create_smoke_test.sql",
    ]);
    assert.deepEqual(rows, [{ name: "0001_create_smoke_test.sql" }]);
  });

  it("does not reapply an already-applied migration", async () => {
    const applied = await runMigrations(pool, migrationsDir);
    assert.deepEqual(applied, []);
  });

  it("refuses to start if an applied migration's content has changed", async () => {
    await writeFile(
      path.join(migrationsDir, "0001_create_smoke_test.sql"),
      "CREATE TABLE migration_smoke_test (id int PRIMARY KEY, changed boolean);",
    );

    await assert.rejects(() => runMigrations(pool, migrationsDir), /content has changed/);
  });
});

describe("runMigrations, order of application", () => {
  let pool: DbPool;
  let migrationsDir: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await pool.query("DROP TABLE IF EXISTS order_smoke_test_a");
    await pool.query("DROP TABLE IF EXISTS order_smoke_test_b");
    // schema_migrations is also used by the real migrations in apps/api/migrations
    // (see schema.test.ts): only remove this fixture's own rows, never the whole table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      "DELETE FROM schema_migrations WHERE name IN ('0001_create_order_smoke_test_a.sql', '0002_create_order_smoke_test_b.sql')",
    );
    migrationsDir = await mkdtemp(path.join(tmpdir(), "envelope-migrations-order-"));
  });

  after(async () => {
    await pool.query("DROP TABLE IF EXISTS order_smoke_test_a");
    await pool.query("DROP TABLE IF EXISTS order_smoke_test_b");
    await pool.query(
      "DELETE FROM schema_migrations WHERE name IN ('0001_create_order_smoke_test_a.sql', '0002_create_order_smoke_test_b.sql')",
    );
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it("applies migrations in filename order, even if written to disk in reverse", async () => {
    await writeFile(
      path.join(migrationsDir, "0002_create_order_smoke_test_b.sql"),
      "CREATE TABLE order_smoke_test_b (id int PRIMARY KEY);",
    );
    await writeFile(
      path.join(migrationsDir, "0001_create_order_smoke_test_a.sql"),
      "CREATE TABLE order_smoke_test_a (id int PRIMARY KEY);",
    );

    const applied = await runMigrations(pool, migrationsDir);

    assert.deepEqual(applied, [
      "0001_create_order_smoke_test_a.sql",
      "0002_create_order_smoke_test_b.sql",
    ]);
    const { rows } = await pool.query(
      "SELECT name FROM schema_migrations WHERE name = ANY($1) ORDER BY name",
      [["0001_create_order_smoke_test_a.sql", "0002_create_order_smoke_test_b.sql"]],
    );
    assert.deepEqual(rows, [
      { name: "0001_create_order_smoke_test_a.sql" },
      { name: "0002_create_order_smoke_test_b.sql" },
    ]);
  });
});
