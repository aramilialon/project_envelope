/**
 * Every real environment gives envelope_app (ADR 0006) a login and a password out of band, never
 * in a migration or in the repository (#9). Tests connect instead as a login role of their own
 * test database, a member of envelope_app, and never touch envelope_app's own login (role-login.ts,
 * #585): any test file can call these, in any order, and parallel runs against other databases on
 * the same server, or a dev server there, are never affected.
 */
import type { DbPool } from "../db/pool.ts";
import { ensureTestRoleLogin, roleConnectionString, testRoleLogin, type TestRoleLogin } from "./role-login.ts";

/** The run's own login standing in for envelope_app, derived from `DATABASE_URL`. */
export function appRoleLogin(): TestRoleLogin {
  return testRoleLogin("envelope_app", requireDatabaseUrl());
}

export async function ensureAppRoleLogin(pool: DbPool): Promise<void> {
  await ensureTestRoleLogin(pool, "envelope_app", appRoleLogin());
}

/** `databaseUrl` (the run's database, or a throwaway one on the same server) as the run's envelope_app login. */
export function appConnectionString(databaseUrl: string): string {
  const { role, password } = appRoleLogin();
  return roleConnectionString(databaseUrl, role, password);
}

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Set DATABASE_URL to a test database before running the integration tests");
  }
  return databaseUrl;
}
