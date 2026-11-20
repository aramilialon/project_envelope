/**
 * A throwaway database of its own, on the same server as `DATABASE_URL`, for the few test files
 * whose code under test reads the whole database rather than one workspace: the
 * `scheduled-transactions-fire` job enumerates every workspace (#38), so in the shared test
 * database any workspace another test file left behind (or a run that crashed before its own
 * cleanup) would be fired too, and could fail or slow down that job (#519). Migrate it like any
 * other test database; `drop()` removes it, and the `envelope_app`/`envelope_queue` roles it uses
 * are the server's own, shared with every other database.
 *
 * Needs the `DATABASE_URL` user to be allowed to create databases (the superuser it already is in
 * development and in CI). Names are random hex, never external input, so they are safe to embed.
 */
import { randomBytes } from "node:crypto";

import { createPool } from "../db/pool.ts";

export interface IsolatedDatabase {
  readonly databaseUrl: string;
  /** Ends nothing by itself: close every pool on `databaseUrl` first. */
  drop(): Promise<void>;
}

export async function createIsolatedDatabase(databaseUrl: string): Promise<IsolatedDatabase> {
  const url = new URL(databaseUrl);
  const base = url.pathname.slice(1).slice(0, 40) || "envelope_test";
  const name = `${base}_${randomBytes(6).toString("hex")}`;
  await onServer(databaseUrl, `CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  return {
    databaseUrl: url.toString(),
    drop: () => onServer(databaseUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
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
