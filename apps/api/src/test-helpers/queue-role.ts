/**
 * Mirrors app-role.ts for envelope_queue (#34): every real environment gives
 * it a login and a password out of band, never in a migration or in the
 * repository. Tests use the developer's own (`QUEUE_DATABASE_URL`, from the
 * environment or `apps/api/.env`), else a fixed test-only one, granted only
 * when the role cannot already log in with it (role-login.ts, #519).
 */
import type { DbPool } from "../db/pool.ts";
import { ensureRoleLogin, roleConnectionString, rolePassword } from "./role-login.ts";

/** Used only when neither the environment nor `apps/api/.env` gives one (CI, a fresh checkout). */
export const QUEUE_ROLE_FALLBACK_PASSWORD = "envelope-queue-test-password";

const queueRolePassword = rolePassword("envelope_queue", "QUEUE_DATABASE_URL", QUEUE_ROLE_FALLBACK_PASSWORD);

export async function ensureQueueRoleLogin(pool: DbPool): Promise<void> {
  await ensureRoleLogin(pool, "envelope_queue", queueRolePassword);
}

export function queueConnectionString(databaseUrl: string): string {
  return roleConnectionString(databaseUrl, "envelope_queue", queueRolePassword);
}
