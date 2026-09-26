/**
 * Every real environment gives envelope_app (ADR 0006) a login and a
 * password out of band, never in a migration or in the repository (#9).
 * Tests need one too: this grants a fixed, test-only password, idempotently
 * and cluster-wide (roles aren't per-database), so any test file can call it
 * and get a working envelope_app connection regardless of run order.
 *
 * ALTER ROLE's PASSWORD clause does not accept a bind parameter ($1); this is
 * safe to embed directly because it is our own constant, never external input.
 */
import type { DbPool } from "../db/pool.ts";

export const APP_ROLE_PASSWORD = "envelope-app-test-password";

export async function ensureAppRoleLogin(pool: DbPool): Promise<void> {
  await pool.query(`ALTER ROLE envelope_app WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
}

export function appConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "envelope_app";
  url.password = APP_ROLE_PASSWORD;
  return url.toString();
}
