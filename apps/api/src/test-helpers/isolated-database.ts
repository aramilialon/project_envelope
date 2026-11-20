/**
 * A throwaway database of its own, on the same server as `DATABASE_URL`, for the few test files
 * whose code under test reads the whole database rather than one workspace: the
 * `scheduled-transactions-fire` job enumerates every workspace (#38), so in the shared test
 * database any workspace another test file left behind (or a run that crashed before its own
 * cleanup) would be fired too, and could fail or slow down that job (#519). Migrate it like any
 * other test database; `drop()` removes it, and the `envelope_app`/`envelope_queue` roles it uses
 * are the server's own, shared with every other database.
 *
 * Its name is `DATABASE_URL`'s database name (at most 40 characters of it) followed by `_` and 12
 * random hex digits; a run killed before `drop()` leaves one behind (apps/api/README.md shows how
 * to remove them). Needs the `DATABASE_URL` user to be allowed to create databases (the superuser
 * it already is in development and in CI).
 */
import { randomBytes } from "node:crypto";

import { createPool } from "../db/pool.ts";

export interface IsolatedDatabase {
  readonly databaseUrl: string;
  /** Close every pool on `databaseUrl` first: `WITH (FORCE)` would cut them off anyway. */
  drop(): Promise<void>;
}

export async function createIsolatedDatabase(databaseUrl: string): Promise<IsolatedDatabase> {
  const url = new URL(databaseUrl);
  const base = decodeURIComponent(url.pathname.slice(1)).slice(0, 40) || "envelope_test";
  const name = `${base}_${randomBytes(6).toString("hex")}`;
  // CREATE/DROP DATABASE take no bind parameters. Part of the name comes from DATABASE_URL, so it
  // is quoted as an identifier (any `"` doubled) rather than trusted as is.
  const identifier = `"${name.replaceAll('"', '""')}"`;
  await onServer(databaseUrl, `CREATE DATABASE ${identifier}`);
  url.pathname = `/${encodeURIComponent(name)}`;
  return {
    databaseUrl: url.toString(),
    drop: () => onServer(databaseUrl, `DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`),
  };
}

async function onServer(databaseUrl: string, statement: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(statement);
  } finally {
    await pool.end();
  }
}
