/**
 * Mirrors app-role.ts for envelope_queue (#34): every real environment gives
 * it a login and a password out of band, never in a migration or in the
 * repository. Tests need one too, granted idempotently and cluster-wide.
 *
 * ALTER ROLE's PASSWORD clause does not accept a bind parameter ($1); this is
 * safe to embed directly because it is our own constant, never external input.
 */
import type { DbPool } from "../db/pool.ts";

export const QUEUE_ROLE_PASSWORD = "envelope-queue-test-password";

export async function ensureQueueRoleLogin(pool: DbPool): Promise<void> {
  await pool.query(`ALTER ROLE envelope_queue WITH LOGIN PASSWORD '${QUEUE_ROLE_PASSWORD}'`);
}

export function queueConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "envelope_queue";
  url.password = QUEUE_ROLE_PASSWORD;
  return url.toString();
}
