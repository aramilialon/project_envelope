/**
 * The PostgreSQL side of a disposable environment (#536): its own database on the disposable
 * environments' own server (`instance.ts`, never the shared development server), migrated with
 * `apps/api`'s own runner, plus the one step done with direct SQL — giving the editor and
 * read-only personas their membership, since no API adds a member to a workspace yet. Everything
 * here connects as that server's superuser, which stays in this process: the environment's API
 * gets connections as the run's own two roles (`createRunRoles`), to its own database only.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { assertExploreServerUrl } from "./instance.ts";
import { assertExploreDatabase, DATABASE_PREFIX, RUN_ROLE, runRoleName } from "./names.ts";

const MIGRATE_TS = fileURLToPath(new URL("../../apps/api/src/db/migrate.ts", import.meta.url));
const COMMENT_PREFIX = "envelope-explore created=";

async function withPool<T>(connectionString: string, run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  assertExploreServerUrl(connectionString);
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
  /** From the comment `createDatabase` set, else the last change of the database's directory. */
  readonly createdAt: Date | undefined;
}

export async function listExploreDatabases(superuserUrl: string): Promise<ExploreDatabase[]> {
  return withPool(superuserUrl, async (pool) => {
    // With no comment (a run stopped between CREATE and COMMENT), the last change of the
    // database's own directory stands in for its age: never older than the database itself.
    const { rows } = await pool.query<{ datname: string; comment: string | null; modified: Date | null }>(
      `SELECT datname, shobj_description(oid, 'pg_database') AS comment,
              (pg_stat_file('base/' || oid, true)).modification AS modified
         FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname`,
      [DATABASE_PREFIX],
    );
    return rows.map((row) => {
      const stamp = row.comment?.startsWith(COMMENT_PREFIX) ? new Date(row.comment.slice(COMMENT_PREFIX.length)) : undefined;
      const createdAt = stamp && !Number.isNaN(stamp.getTime()) ? stamp : (row.modified ?? undefined);
      return { name: row.datname, createdAt };
    });
  });
}

/** Runs `apps/api`'s own migration runner against `databaseUrl` (a superuser connection to the run's database). */
export async function migrate(databaseUrl: string, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  assertExploreServerUrl(databaseUrl);
  const child = spawn(process.execPath, [MIGRATE_TS], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", resolve);
  });
  signal.throwIfAborted();
  if (code !== 0) {
    throw new Error(`Migrating the database failed:\n${output}`);
  }
  log(`${output.trim().split(",").length} migrations applied`);
}

/**
 * Gives a run its own two login roles, `envelope_app_<run>` and `envelope_queue_<run>`, members of
 * `envelope_app`/`envelope_queue` so every grant and Row-Level Security policy for those applies,
 * and lets them (and only them, besides the superuser) connect to the run's database. One run's
 * credentials therefore open no other run's database.
 */
export async function createRunRoles(
  superuserUrl: string,
  database: string,
  run: string,
  passwords: { readonly app: string; readonly queue: string },
): Promise<{ app: string; queue: string }> {
  assertExploreDatabase(database);
  const app = runRoleName("envelope_app", run);
  const queue = runRoleName("envelope_queue", run);
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  await withPool(superuserUrl, async (pool) => {
    // CREATE ROLE's PASSWORD clause takes no bind parameter; the passwords are quoted as literals.
    await pool.query(`CREATE ROLE ${identifier(app)} LOGIN PASSWORD ${literal(passwords.app)} IN ROLE envelope_app`);
    await pool.query(`CREATE ROLE ${identifier(queue)} LOGIN PASSWORD ${literal(passwords.queue)} IN ROLE envelope_queue`);
    await pool.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${identifier(database)} FROM PUBLIC`);
    await pool.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(app)}, ${identifier(queue)}`);
  });
  return { app, queue };
}

/**
 * Closes everything on the server a run's roles have no business opening: `envelope_app` and
 * `envelope_queue` themselves cannot log in (an instance set up before per-run roles gave them a
 * password), and no database but the runs' own lets PUBLIC connect — `postgres`, the superuser's
 * own and `template1` included. Idempotent; another run doing the same at the same moment is not
 * an error.
 */
export async function closeSharedAccess(superuserUrl: string): Promise<void> {
  await withPool(superuserUrl, async (pool) => {
    const statements: string[] = [];
    const { rows: roles } = await pool.query<{ rolname: string }>(
      "SELECT rolname FROM pg_authid WHERE rolname IN ('envelope_app', 'envelope_queue') AND (rolcanlogin OR rolpassword IS NOT NULL)",
    );
    for (const { rolname } of roles) {
      statements.push(`ALTER ROLE ${identifier(rolname)} NOLOGIN PASSWORD NULL`);
    }
    const { rows: databases } = await pool.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datallowconn AND NOT starts_with(datname, $1)
          AND (datacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(datacl) a WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT'))`,
      [DATABASE_PREFIX],
    );
    for (const { datname } of databases) {
      statements.push(`REVOKE CONNECT, TEMPORARY ON DATABASE ${identifier(datname)} FROM PUBLIC`);
    }
    for (const statement of statements) {
      try {
        await pool.query(statement);
      } catch (error) {
        // "tuple concurrently updated": another run is closing the same thing right now.
        if ((error as { code?: string }).code !== "XX000") {
          throw error;
        }
      }
    }
  });
}

/** Drops a run's two roles, once its database (which their objects lived in) is gone. True if any existed. */
export async function dropRunRoles(superuserUrl: string, run: string): Promise<boolean> {
  const roles = [runRoleName("envelope_app", run), runRoleName("envelope_queue", run)];
  return withPool(superuserUrl, async (pool) => {
    const { rowCount } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [roles]);
    for (const role of roles) {
      await pool.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
    }
    return (rowCount ?? 0) > 0;
  });
}

/** Runs that still have a role on the server (for `sweep`, whose database may already be gone). */
export async function listRunsWithRoles(superuserUrl: string): Promise<string[]> {
  return withPool(superuserUrl, async (pool) => {
    const { rows } = await pool.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname ~ '^envelope_(app|queue)_[0-9a-f]{8}$'");
    return [...new Set(rows.map((row) => RUN_ROLE.exec(row.rolname)?.[2]).filter((run): run is string => run !== undefined))];
  });
}

/** Adds `userId` to `workspaceId` with `role`: the one step no API offers yet. */
export async function addMembership(databaseUrl: string, userId: string, workspaceId: string, role: string): Promise<void> {
  assertExploreDatabase(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)));
  await withPool(databaseUrl, (pool) =>
    pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [userId, workspaceId, role]),
  );
}
