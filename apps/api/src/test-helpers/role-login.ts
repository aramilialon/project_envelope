/**
 * Gives one of the migrations' NOLOGIN roles (`envelope_app`, `envelope_queue`) a login with a
 * fixed, test-only password, only when it cannot already log in with it (#519). Roles are
 * cluster-wide, not per-database: an unconditional `ALTER ROLE` on every run let parallel runs
 * against one server collide ("tuple concurrently updated") and rewrote the password every time.
 * Now the first run against a server sets it, and every later run only checks it.
 *
 * ALTER ROLE's PASSWORD clause does not accept a bind parameter ($1); embedding is safe because
 * the role and the password are our own constants, never external input.
 */
import { createPool, type DbPool } from "../db/pool.ts";

export async function ensureRoleLogin(pool: DbPool, role: string, password: string): Promise<void> {
  const databaseUrl = pool.options.connectionString;
  if (!databaseUrl) {
    throw new Error("ensureRoleLogin needs a pool created from a connection string");
  }
  const roleUrl = roleConnectionString(databaseUrl, role, password);
  if (await canLogIn(roleUrl)) {
    return;
  }
  try {
    await pool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
  } catch (error) {
    // Another run against the same server may have set it at the same moment: it sets this same
    // password, so only a login that still fails afterwards is a real error.
    if (!(await canLogIn(roleUrl))) {
      throw error;
    }
  }
}

export function roleConnectionString(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function canLogIn(databaseUrl: string): Promise<boolean> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}
