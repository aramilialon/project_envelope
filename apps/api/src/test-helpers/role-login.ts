/**
 * Gives one of the migrations' NOLOGIN roles (`envelope_app`, `envelope_queue`) a login for the
 * tests, only when it cannot already log in with the expected password (#519). Roles are
 * cluster-wide, not per-database: an unconditional `ALTER ROLE` on every run let parallel runs
 * against one server collide ("tuple concurrently updated") and rewrote the password every time.
 *
 * The expected password is the one the developer's own server already uses, so a test run never
 * changes a password a dev server relies on: taken from `APP_DATABASE_URL`/`QUEUE_DATABASE_URL`
 * in the environment, else from `apps/api/.env`, else (CI, a fresh checkout) a fixed test-only
 * value. `scripts/dev/reset-role-passwords.sh` sets the same `.env` passwords, so it and a test
 * run can even run at the same time.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { createPool, type DbPool } from "../db/pool.ts";

const API_ENV_FILE = new URL("../../.env", import.meta.url);

/**
 * The password `role` should log in with in tests: the one in `variable` (a connection string
 * for that same role) from the environment or `apps/api/.env`, else `fallback`.
 */
export function rolePassword(role: string, variable: string, fallback: string): string {
  for (const value of [process.env[variable], readApiEnvFile()[variable]]) {
    const password = value ? passwordFor(role, value) : undefined;
    if (password) {
      return password;
    }
  }
  return fallback;
}

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
    // ALTER ROLE's PASSWORD clause takes no bind parameter ($1). The role is our own constant;
    // the password may come from a developer's .env, so it is quoted as a literal (`'` doubled).
    await pool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
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
  url.password = encodeURIComponent(password);
  return url.toString();
}

function passwordFor(role: string, connectionString: string): string | undefined {
  try {
    const url = new URL(connectionString);
    return decodeURIComponent(url.username) === role && url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    return undefined;
  }
}

function readApiEnvFile(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(API_ENV_FILE, "utf8"));
  } catch {
    return {};
  }
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
