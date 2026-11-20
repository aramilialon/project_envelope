/**
 * The PostgreSQL side of a disposable environment (#536): its own database on the shared server,
 * migrated with `apps/api`'s own runner, plus the one step done with direct SQL — giving the
 * editor and read-only personas their membership, since no API adds a member to a workspace yet.
 * Everything here connects as the superuser in `DATABASE_URL`, which stays in this process: the
 * environment's API gets `envelope_app`/`envelope_queue` connections to its own database only.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import pg from "pg";

import { assertExploreDatabase, DATABASE_PREFIX } from "./names.ts";

const MIGRATE_TS = fileURLToPath(new URL("../../apps/api/src/db/migrate.ts", import.meta.url));
const API_ENV_FILE = fileURLToPath(new URL("../../apps/api/.env", import.meta.url));
const COMMENT_PREFIX = "envelope-explore created=";

/** The same fixed values `apps/api`'s own tests fall back to (test-helpers/app-role.ts, queue-role.ts). */
const ROLE_FALLBACK_PASSWORDS: Readonly<Record<string, string>> = {
  envelope_app: "envelope-app-test-password",
  envelope_queue: "envelope-queue-test-password",
};

async function withPool<T>(connectionString: string, run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `connectionString` with its database (and, when given, its user and password) replaced. */
export function connectionTo(connectionString: string, database: string, login?: { user: string; password: string }): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  if (login) {
    url.username = encodeURIComponent(login.user);
    url.password = encodeURIComponent(login.password);
  }
  return url.toString();
}

export async function createDatabase(superuserUrl: string, name: string, createdAt: Date): Promise<void> {
  assertExploreDatabase(name);
  await withPool(superuserUrl, async (pool) => {
    await pool.query(`CREATE DATABASE ${identifier(name)}`);
    // COMMENT takes no bind parameters; the value is our own ISO timestamp.
    await pool.query(`COMMENT ON DATABASE ${identifier(name)} IS '${COMMENT_PREFIX}${createdAt.toISOString()}'`);
  });
}

export async function dropDatabase(superuserUrl: string, name: string): Promise<boolean> {
  assertExploreDatabase(name);
  return withPool(superuserUrl, async (pool) => {
    const { rowCount } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    await pool.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
    return (rowCount ?? 0) > 0;
  });
}

export interface ExploreDatabase {
  readonly name: string;
  /** From the comment `createDatabase` set; undefined if it is missing. */
  readonly createdAt: Date | undefined;
}

export async function listExploreDatabases(superuserUrl: string): Promise<ExploreDatabase[]> {
  return withPool(superuserUrl, async (pool) => {
    const { rows } = await pool.query<{ datname: string; comment: string | null }>(
      "SELECT datname, shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname",
      [DATABASE_PREFIX],
    );
    return rows.map((row) => {
      const stamp = row.comment?.startsWith(COMMENT_PREFIX) ? new Date(row.comment.slice(COMMENT_PREFIX.length)) : undefined;
      return { name: row.datname, createdAt: stamp && !Number.isNaN(stamp.getTime()) ? stamp : undefined };
    });
  });
}

/** Runs `apps/api`'s own migration runner against `databaseUrl` (a superuser connection to the run's database). */
export async function migrate(databaseUrl: string, log: (line: string) => void): Promise<void> {
  const child = spawn(process.execPath, [MIGRATE_TS], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (code !== 0) {
    throw new Error(`Migrating the database failed:\n${output}`);
  }
  log(`${output.trim().split(",").length} migrations applied`);
}

/**
 * The password `role` logs in with: the one in `variable` (a connection string for that role) in
 * this process's environment, else in `apps/api/.env`, else the tests' own fixed value.
 */
export function rolePassword(role: string, variable: string): string {
  let fileEnv: Record<string, string | undefined> = {};
  try {
    fileEnv = parseEnv(readFileSync(API_ENV_FILE, "utf8"));
  } catch {
    // No apps/api/.env (CI, a fresh checkout or a worktree): fall through.
  }
  for (const value of [process.env[variable], fileEnv[variable]]) {
    if (!value) {
      continue;
    }
    try {
      const url = new URL(value);
      if (decodeURIComponent(url.username) === role && url.password) {
        return decodeURIComponent(url.password);
      }
    } catch {
      // Not a URL: ignore it.
    }
  }
  const fallback = ROLE_FALLBACK_PASSWORDS[role];
  if (!fallback) {
    throw new Error(`No password known for role ${role}`);
  }
  return fallback;
}

/**
 * Makes sure `role` can log in to `database` with `password`. Roles are shared by every database
 * on the server, and a developer's own API uses them too, so an existing password is never
 * changed: only a role with no password at all (a fresh server, CI) gets one.
 */
export async function ensureRoleLogin(superuserUrl: string, database: string, role: string, password: string, variable: string): Promise<void> {
  const roleUrl = connectionTo(superuserUrl, database, { user: role, password });
  if (await canLogIn(roleUrl)) {
    return;
  }
  await withPool(superuserUrl, async (pool) => {
    const { rows } = await pool.query<{ has_password: boolean }>(
      "SELECT rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname = $1",
      [role],
    );
    if (rows[0]?.has_password) {
      throw new Error(
        `${role} cannot log in with the password this tool found, and it already has another one. ` +
          `Set ${variable} (as in apps/api/.env) so this tool uses the same password; it never changes an existing one.`,
      );
    }
    try {
      // ALTER ROLE's PASSWORD clause takes no bind parameter; the password is quoted as a literal.
      await pool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    } catch (error) {
      // Another run may have set the same password at the same moment.
      if (!(await canLogIn(roleUrl))) {
        throw error;
      }
    }
  });
}

async function canLogIn(connectionString: string): Promise<boolean> {
  try {
    await withPool(connectionString, (pool) => pool.query("SELECT 1"));
    return true;
  } catch {
    return false;
  }
}

/** Adds `userId` to `workspaceId` with `role`: the one step no API offers yet. */
export async function addMembership(databaseUrl: string, userId: string, workspaceId: string, role: string): Promise<void> {
  assertExploreDatabase(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)));
  await withPool(databaseUrl, (pool) =>
    pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [userId, workspaceId, role]),
  );
}
