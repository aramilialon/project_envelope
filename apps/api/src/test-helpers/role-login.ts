/**
 * The tests' own login roles for the migrations' NOLOGIN roles `envelope_app` and `envelope_queue`
 * (#585). Tests never give those two shared roles a login or a password: roles are cluster-wide,
 * not per database, so a run that set their password (to the one its checkout knew) changed it for
 * every other run on the same server, and for a dev server too. A running server whose pool then
 * opened a new connection got `28P01` ("password authentication failed") and answered 500: the
 * intermittent failure of the walk's real-process run while another run used the same server.
 *
 * Instead each test database gets two roles of its own, `envelope_app_t<16 hex>` and
 * `envelope_queue_t<16 hex>`, members of `envelope_app`/`envelope_queue` (so every grant and
 * Row-Level Security policy for those applies, as for the disposable environments' per-run roles).
 * Both the name and the password are derived from `DATABASE_URL`: the name from its server and
 * database, the password from the name keyed with `DATABASE_URL`'s own password, so it cannot be
 * guessed without the superuser's password. Every test file of a run, in any process, computes the
 * same pair without coordinating, and a run against another database never touches them.
 *
 * Each such role carries a comment naming its database; creating one drops the roles whose database
 * no longer exists (a run that dropped its private database at the end), when they own nothing left.
 */
import { createHash, createHmac } from "node:crypto";

import { createPool, type DbPool } from "../db/pool.ts";

export type SharedRole = "envelope_app" | "envelope_queue";

const COMMENT_PREFIX = "envelope-test-role database=";
/** The names `testRoleName` gives, and nothing else: the only roles the sweep may drop. */
const TEST_ROLE = /^envelope_(app|queue)_t[0-9a-f]{16}$/;

export interface TestRoleLogin {
  readonly role: string;
  readonly password: string;
}

/** The test role standing in for `sharedRole` in the database `databaseUrl` (normally `DATABASE_URL`) names. */
export function testRoleLogin(sharedRole: SharedRole, databaseUrl: string): TestRoleLogin {
  const url = new URL(databaseUrl);
  const key = `${url.hostname}:${url.port || "5432"}/${databaseName(databaseUrl)}`;
  const role = `${sharedRole}_t${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const password = createHmac("sha256", `envelope-test-role:${decodeURIComponent(url.password)}`).update(role).digest("hex");
  return { role, password };
}

/**
 * Makes sure `login` (from `testRoleLogin`) can log in through `pool`'s server, creating the role,
 * or setting its password, only when it cannot. `pool` connects as a superuser (`DATABASE_URL`).
 */
export async function ensureTestRoleLogin(pool: DbPool, sharedRole: SharedRole, login: TestRoleLogin): Promise<void> {
  const databaseUrl = pool.options.connectionString;
  if (!databaseUrl) {
    throw new Error("ensureTestRoleLogin needs a pool created from a connection string");
  }
  const roleUrl = roleConnectionString(databaseUrl, login.role, login.password);
  if (await canLogIn(roleUrl)) {
    return;
  }
  await dropStaleTestRoles(pool);
  // CREATE/ALTER ROLE's PASSWORD clause and COMMENT take no bind parameter ($1). The role names
  // are our own (checked against TEST_ROLE), the password is hex; the database name comes from
  // DATABASE_URL, so it is quoted as a literal (`'` doubled).
  if (!TEST_ROLE.test(login.role) || !/^[0-9a-f]+$/.test(login.password)) {
    throw new Error(`Not a test role login: ${login.role}`);
  }
  const comment = `${COMMENT_PREFIX}${databaseName(databaseUrl)}`.replaceAll("'", "''");
  try {
    await pool.query(`CREATE ROLE ${login.role} LOGIN PASSWORD '${login.password}' IN ROLE ${sharedRole}`);
  } catch (error) {
    // It exists already (another test file, maybe in another process, created it a moment ago, or
    // DATABASE_URL's password changed since): then its password is the one to set.
    if (!isConcurrentOrDuplicate(error)) {
      throw error;
    }
    await setPassword(pool, login, roleUrl);
  }
  await pool.query(`COMMENT ON ROLE ${login.role} IS '${comment}'`).catch((error: unknown) => {
    if (!isConcurrentOrDuplicate(error)) throw error;
  });
}

export function roleConnectionString(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = encodeURIComponent(password);
  return url.toString();
}

async function setPassword(pool: DbPool, login: TestRoleLogin, roleUrl: string): Promise<void> {
  if (await canLogIn(roleUrl)) {
    return;
  }
  try {
    await pool.query(`ALTER ROLE ${login.role} WITH LOGIN PASSWORD '${login.password}'`);
  } catch (error) {
    // Another file of the same run setting the same password at the same moment.
    if (!isConcurrentOrDuplicate(error) || !(await canLogIn(roleUrl))) {
      throw error;
    }
  }
}

/** Drops the test roles whose database is gone; one that still owns something elsewhere stays. */
async function dropStaleTestRoles(pool: DbPool): Promise<void> {
  const { rows } = await pool.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_roles r
      WHERE r.rolname ~ '^envelope_(app|queue)_t[0-9a-f]{16}$'
        AND starts_with(shobj_description(r.oid, 'pg_authid'), $1)
        AND NOT EXISTS (
          SELECT 1 FROM pg_database d
           WHERE d.datname = substr(shobj_description(r.oid, 'pg_authid'), length($1) + 1))`,
    [COMMENT_PREFIX],
  );
  for (const { rolname } of rows) {
    if (!TEST_ROLE.test(rolname)) continue;
    try {
      await pool.query(`DROP ROLE IF EXISTS ${rolname}`);
    } catch {
      // It still owns objects (in a leftover database), or another run is dropping it right now.
    }
  }
}

function isConcurrentOrDuplicate(error: unknown): boolean {
  // 42710 duplicate_object, 23505 unique_violation (two CREATE ROLE at once), XX000 "tuple concurrently updated".
  const code = (error as { code?: string }).code;
  return code === "42710" || code === "23505" || code === "XX000";
}

function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
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
