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
 *
 * `pool.end()` resolves as soon as the pool has asked its clients to close, before their server
 * processes have exited. `WITH (FORCE)` would terminate such a process, and the client still
 * closing gets "terminating connection due to administrator command" as an error its pool has no
 * listener for: an uncaught exception that fails the test file. So `drop()` first waits until
 * no session is connected to the database any more, and only then drops it.
 */
import { randomBytes } from "node:crypto";

import { createPool, type DbPool } from "../db/pool.ts";

export interface IsolatedDatabase {
  readonly databaseUrl: string;
  /**
   * Close every pool on `databaseUrl` first. Waits until their connections are gone (up to a few
   * seconds), then drops the database `WITH (FORCE)`, which ends any session still left.
   */
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
    drop: () =>
      onServer(databaseUrl, async (pool) => {
        await waitForNoSessions(pool, name);
        await pool.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
      }),
  };
}

const SESSION_WAIT_MS = 5_000;

/** Until no session is connected to `name`, or `SESSION_WAIT_MS` has passed. */
async function waitForNoSessions(pool: DbPool, name: string): Promise<void> {
  const deadline = Date.now() + SESSION_WAIT_MS;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name]);
    if (rows[0]!.n === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function onServer(databaseUrl: string, statement: string | ((pool: DbPool) => Promise<void>)): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    if (typeof statement === "string") {
      await pool.query(statement);
    } else {
      await statement(pool);
    }
  } finally {
    await pool.end();
  }
}
