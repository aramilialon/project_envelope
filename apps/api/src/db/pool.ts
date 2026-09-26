/**
 * The only place that imports "pg" directly (ADR 0005: node-postgres is the
 * project's single database driver). Everything else gets a pool from here.
 */
import pg from "pg";

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): DbPool {
  return new pg.Pool({ connectionString: databaseUrl });
}
