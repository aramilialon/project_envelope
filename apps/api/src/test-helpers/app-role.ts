/**
 * Every real environment gives envelope_app (ADR 0006) a login and a
 * password out of band, never in a migration or in the repository (#9).
 * Tests need one too: this grants a fixed, test-only password, only when the
 * role cannot already log in with it (role-login.ts, #519), so any test file
 * can call it and get a working envelope_app connection regardless of run
 * order, and parallel runs against one server do not collide.
 */
import type { DbPool } from "../db/pool.ts";
import { ensureRoleLogin, roleConnectionString } from "./role-login.ts";

export const APP_ROLE_PASSWORD = "envelope-app-test-password";

export async function ensureAppRoleLogin(pool: DbPool): Promise<void> {
  await ensureRoleLogin(pool, "envelope_app", APP_ROLE_PASSWORD);
}

export function appConnectionString(databaseUrl: string): string {
  return roleConnectionString(databaseUrl, "envelope_app", APP_ROLE_PASSWORD);
}
