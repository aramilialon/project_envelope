/**
 * Mirrors app-role.ts for envelope_queue (#34): tests connect as a login role of their own test
 * database, a member of envelope_queue, and never touch envelope_queue's own login (role-login.ts,
 * #585).
 */
import type { DbPool } from "../db/pool.ts";
import { requireDatabaseUrl } from "./app-role.ts";
import { ensureTestRoleLogin, roleConnectionString, testRoleLogin, type TestRoleLogin } from "./role-login.ts";

/** The run's own login standing in for envelope_queue, derived from `DATABASE_URL`. */
export function queueRoleLogin(): TestRoleLogin {
  return testRoleLogin("envelope_queue", requireDatabaseUrl());
}

export async function ensureQueueRoleLogin(pool: DbPool): Promise<void> {
  await ensureTestRoleLogin(pool, "envelope_queue", queueRoleLogin());
}

/** `databaseUrl` (the run's database, or a throwaway one on the same server) as the run's envelope_queue login. */
export function queueConnectionString(databaseUrl: string): string {
  const { role, password } = queueRoleLogin();
  return roleConnectionString(databaseUrl, role, password);
}
