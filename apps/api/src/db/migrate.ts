/**
 * Applies pending SQL migrations from apps/api/migrations, in filename order,
 * each in its own transaction, and records the applied file names and their
 * checksums in `schema_migrations`. Refuses to start if an applied file's
 * content no longer matches its recorded checksum (ADR 0005).
 *
 * Several runners can start at once against one database (two API instances,
 * an instance and `pnpm migrate`, the integration test files of one run): each
 * takes a PostgreSQL advisory lock first and holds it until it is done, so the
 * others wait, then find nothing left to apply (ADR 0016).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadDatabaseUrl } from "../config.ts";
import { createPool, type DbClient, type DbPool } from "./pool.ts";

export const DEFAULT_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

/**
 * The key of the migration runner's advisory lock: "envelope" in ASCII, as a bigint. Advisory
 * locks belong to one database, so runners on different databases of one server never wait on
 * each other; nothing else in the app takes an advisory lock on this key.
 */
export const MIGRATION_LOCK_KEY = "7308332045390876773";

interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

export async function runMigrations(
  pool: DbPool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  // One connection for the whole run: a session-level advisory lock belongs to the connection
  // that took it. On any error the connection is closed rather than returned to the pool, which
  // releases the lock even if the error left the session unable to unlock it.
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    const newlyApplied = await applyPending(client, migrationsDir);
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    return newlyApplied;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    client.release(failed);
  }
}

async function applyPending(client: DbClient, migrationsDir: string): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await loadApplied(client);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = applied.get(file);

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration "${file}" was already applied but its content has changed: create a new file instead of editing it`,
        );
      }
      continue;
    }

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    newlyApplied.push(file);
  }

  return newlyApplied;
}

async function loadApplied(client: DbClient): Promise<Map<string, AppliedMigration>> {
  const result = await client.query<AppliedMigration>("SELECT name, checksum FROM schema_migrations");
  return new Map(result.rows.map((row): [string, AppliedMigration] => [row.name, row]));
}

async function main(): Promise<void> {
  const pool = createPool(loadDatabaseUrl());
  try {
    const applied = await runMigrations(pool);
    console.log(applied.length === 0 ? "No pending migrations." : `Applied: ${applied.join(", ")}`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
