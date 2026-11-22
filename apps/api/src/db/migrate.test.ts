/**
 * The migration runner, on a throwaway database of its own (#638, ADR 0016): its fixtures never
 * touch the run's `schema_migrations`, which every other test file migrates through at the same
 * time, and the tests that start several runners at once see only each other.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

/** A directory of migration files, written in the order given (not necessarily filename order). */
async function migrationsDirWith(prefix: string, files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `envelope-${prefix}-`));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql);
  }
  return dir;
}

async function appliedNames(pool: DbPool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  return rows.map((row) => row.name);
}

/**
 * Each `describe` gets a fresh database: `runMigrations` reads every row of `schema_migrations`,
 * and one block's fixtures must not be another's history.
 */
function withIsolatedDatabase(): { pool: () => DbPool; databaseUrl: () => string; dirs: string[] } {
  let isolated: IsolatedDatabase;
  let pool: DbPool;
  const dirs: string[] = [];
  before(async () => {
    isolated = await createIsolatedDatabase(databaseUrl!);
    pool = createPool(isolated.databaseUrl);
  });
  after(async () => {
    await pool?.end();
    await isolated?.drop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  return { pool: () => pool, databaseUrl: () => isolated.databaseUrl, dirs };
}

describe("runMigrations", () => {
  const db = withIsolatedDatabase();
  let migrationsDir: string;

  before(async () => {
    migrationsDir = await migrationsDirWith("migrations", {
      "0001_create_smoke_test.sql": "CREATE TABLE migration_smoke_test (id int PRIMARY KEY);",
    });
    db.dirs.push(migrationsDir);
  });

  it("applies pending migrations in order and records them", async () => {
    const applied = await runMigrations(db.pool(), migrationsDir);

    assert.deepEqual(applied, ["0001_create_smoke_test.sql"]);
    assert.deepEqual(await appliedNames(db.pool()), ["0001_create_smoke_test.sql"]);
  });

  it("does not reapply an already-applied migration", async () => {
    const applied = await runMigrations(db.pool(), migrationsDir);
    assert.deepEqual(applied, []);
  });

  it("refuses to start if an applied migration's content has changed", async () => {
    await writeFile(
      path.join(migrationsDir, "0001_create_smoke_test.sql"),
      "CREATE TABLE migration_smoke_test (id int PRIMARY KEY, changed boolean);",
    );

    await assert.rejects(() => runMigrations(db.pool(), migrationsDir), /content has changed/);
  });
});

describe("runMigrations, order of application", () => {
  const db = withIsolatedDatabase();

  it("applies migrations in filename order, even if written to disk in reverse", async () => {
    const migrationsDir = await migrationsDirWith("migrations-order", {
      "0002_create_order_smoke_test_b.sql": "CREATE TABLE order_smoke_test_b (id int PRIMARY KEY);",
      "0001_create_order_smoke_test_a.sql": "CREATE TABLE order_smoke_test_a (id int PRIMARY KEY);",
    });
    db.dirs.push(migrationsDir);

    const applied = await runMigrations(db.pool(), migrationsDir);

    assert.deepEqual(applied, ["0001_create_order_smoke_test_a.sql", "0002_create_order_smoke_test_b.sql"]);
    assert.deepEqual(await appliedNames(db.pool()), [
      "0001_create_order_smoke_test_a.sql",
      "0002_create_order_smoke_test_b.sql",
    ]);
  });
});

describe("runMigrations, several runners at once (#638, ADR 0016)", () => {
  const db = withIsolatedDatabase();
  const RUNNERS = 6;
  const FILES = {
    // Slow enough that, without the lock, every runner would read an empty history before the
    // first one recorded anything, and all of them would apply 0001.
    "0001_create_concurrent_a.sql": "SELECT pg_sleep(0.2); CREATE TABLE concurrent_a (id int PRIMARY KEY);",
    "0002_create_concurrent_b.sql": "CREATE TABLE concurrent_b (id int PRIMARY KEY);",
    "0003_fill_concurrent_b.sql": "INSERT INTO concurrent_b (id) VALUES (1);",
  };

  it("applies each migration exactly once, on a database with no history yet", async () => {
    const migrationsDir = await migrationsDirWith("migrations-concurrent", FILES);
    db.dirs.push(migrationsDir);
    // A pool each, as separate processes (API instances, test files) would have.
    const pools = Array.from({ length: RUNNERS }, () => createPool(db.databaseUrl()));
    try {
      const results = await Promise.all(pools.map((pool) => runMigrations(pool, migrationsDir)));

      assert.deepEqual(results.flat().sort(), Object.keys(FILES).sort(), "every file applied by exactly one runner");
      assert.equal(results.filter((applied) => applied.length > 0).length, 1, "the first runner applies them all, the others find nothing to do");
      assert.deepEqual(await appliedNames(db.pool()), Object.keys(FILES).sort());
      const { rows } = await db.pool().query<{ n: number }>("SELECT count(*)::int AS n FROM concurrent_b");
      assert.equal(rows[0]!.n, 1);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it("releases the lock when a migration fails, so the next runner is not kept waiting", { timeout: 15_000 }, async () => {
    const broken = await migrationsDirWith("migrations-broken", {
      ...FILES,
      "0004_broken.sql": "SELECT no_such_function();",
    });
    const fixed = await migrationsDirWith("migrations-fixed", {
      ...FILES,
      "0004_fixed.sql": "CREATE TABLE concurrent_c (id int PRIMARY KEY);",
    });
    db.dirs.push(broken, fixed);
    const first = createPool(db.databaseUrl());
    const second = createPool(db.databaseUrl());
    try {
      await assert.rejects(() => runMigrations(first, broken), /no_such_function/);
      // A runner on another connection: had the failed runner kept the lock on a connection still
      // open in its pool, this would wait for ever (the test's own timeout ends it).
      assert.deepEqual(await runMigrations(second, fixed), ["0004_fixed.sql"]);
    } finally {
      await first.end();
      await second.end();
    }
  });
});
