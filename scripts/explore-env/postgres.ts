/**
 * The PostgreSQL side of a disposable environment (#536): its own database on the disposable
 * environments' own server (`instance.ts`, never the shared development server), migrated with
 * `apps/api`'s own runner, plus the one step done with direct SQL — giving the editor and
 * read-only personas their membership, since no API adds a member to a workspace yet. Everything
 * here connects as that server's superuser, which stays in this process: the environment's API
 * gets `envelope_app`/`envelope_queue` connections to its own database only.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { assertExploreServerUrl } from "./instance.ts";
import { assertExploreDatabase, DATABASE_PREFIX } from "./names.ts";

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
 * Makes sure `role` can log in to `database` with `password`, the instance's own password for it
 * (`instance.ts`). The server is dedicated to disposable environments, so setting it is safe;
 * another run setting the same value at the same moment is not an error.
 */
export async function ensureRoleLogin(superuserUrl: string, database: string, role: "envelope_app" | "envelope_queue", password: string): Promise<void> {
  const roleUrl = connectionTo(superuserUrl, database, { user: role, password });
  if (await canLogIn(roleUrl)) {
    return;
  }
  await withPool(superuserUrl, async (pool) => {
    try {
      // ALTER ROLE's PASSWORD clause takes no bind parameter; the password is quoted as a literal.
      await pool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    } catch (error) {
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
