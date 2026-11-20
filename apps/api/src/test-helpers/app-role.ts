/**
 * Every real environment gives envelope_app (ADR 0006) a login and a
 * password out of band, never in a migration or in the repository (#9).
 * Tests need one too: the developer's own (`APP_DATABASE_URL`, from the
 * environment or `apps/api/.env`), else a fixed test-only one, granted only
 * when the role cannot already log in with it (role-login.ts, #519). Any test
 * file can call it, in any order, and parallel runs do not collide.
 */
import type { DbPool } from "../db/pool.ts";
import { ensureRoleLogin, roleConnectionString, rolePassword } from "./role-login.ts";

/** Used only when neither the environment nor `apps/api/.env` gives one (CI, a fresh checkout). */
export const APP_ROLE_FALLBACK_PASSWORD = "envelope-app-test-password";

const appRolePassword = rolePassword("envelope_app", "APP_DATABASE_URL", APP_ROLE_FALLBACK_PASSWORD);

export async function ensureAppRoleLogin(pool: DbPool): Promise<void> {
  await ensureRoleLogin(pool, "envelope_app", appRolePassword);
}

export function appConnectionString(databaseUrl: string): string {
  return roleConnectionString(databaseUrl, "envelope_app", appRolePassword);
}
