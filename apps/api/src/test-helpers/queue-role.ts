/**
 * Mirrors app-role.ts for envelope_queue (#34): every real environment gives
 * it a login and a password out of band, never in a migration or in the
 * repository. Tests need one too, granted only when the role cannot already
 * log in with it (role-login.ts, #519).
 */
import type { DbPool } from "../db/pool.ts";
import { ensureRoleLogin, roleConnectionString } from "./role-login.ts";

export const QUEUE_ROLE_PASSWORD = "envelope-queue-test-password";

export async function ensureQueueRoleLogin(pool: DbPool): Promise<void> {
  await ensureRoleLogin(pool, "envelope_queue", QUEUE_ROLE_PASSWORD);
}

export function queueConnectionString(databaseUrl: string): string {
  return roleConnectionString(databaseUrl, "envelope_queue", QUEUE_ROLE_PASSWORD);
}
