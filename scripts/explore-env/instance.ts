/**
 * The PostgreSQL server disposable environments use (#536): a server of their own, never the
 * shared development one. `envelope_app` and `envelope_queue` are cluster-wide roles, so a run's
 * API credentials on the shared server would also open the shared `envelope` database; on a
 * dedicated server they open nothing but disposable databases.
 *
 * Locally that server is a container this tool manages, `envelope-explore-postgres` (postgres:17,
 * bound to 127.0.0.1 on port 55432 by default, `EXPLORE_POSTGRES_PORT` to change it, data in the
 * `envelope-explore-postgres-data` volume). Its superuser password and the two roles' passwords
 * are generated once and kept in `~/.config/envelope-explore/` (`$XDG_CONFIG_HOME` if set), a
 * 0700 directory with 0600 files, outside the repository. In CI, `EXPLORE_DATABASE_URL` names a
 * server the workflow provides instead, and no container is managed.
 *
 * Whatever names the server, it must be local, on an explicit port other than 5432, and must not
 * hold an `envelope` or `keycloak` database: the shared server is refused however it is reached.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv, promisify } from "node:util";

import pg from "pg";

import { assertPrivate, ensurePrivateDir } from "./private-dir.ts";

const run = promisify(execFile);

export const CONTAINER = "envelope-explore-postgres";
export const VOLUME = "envelope-explore-postgres-data";
export const DEFAULT_PORT = 55432;
const IMAGE = "postgres:17";
const SUPERUSER = "explore_admin";
const SHARED_PORT = "5432";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
const READY_TIMEOUT_MS = 60_000;

export interface InstanceSecrets {
  readonly superuser: string;
  readonly superuserPassword: string;
  readonly appPassword: string;
  readonly queuePassword: string;
}

export function configDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "envelope-explore");
}

/**
 * Refuses a server URL that is not local, has no explicit port, or uses 5432 (the shared
 * server's port). Pure, so it is tested on its own (`instance.test.ts`).
 */
export function assertExploreServerUrl(url: string): void {
  const parsed = new URL(url);
  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(`Refusing a non-local PostgreSQL server for disposable environments (${parsed.hostname})`);
  }
  if (parsed.port === "" || parsed.port === SHARED_PORT) {
    throw new Error(
      `Refusing PostgreSQL on port ${parsed.port || "5432 (the default)"}: that is the shared development server. Disposable environments use their own (default port ${DEFAULT_PORT}).`,
    );
  }
}

async function readEnvFile(file: string): Promise<Record<string, string | undefined>> {
  await assertPrivate(file, "file");
  return parseEnv(await readFile(file, "utf8"));
}

async function writeEnvFile(file: string, values: Record<string, string>): Promise<void> {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  try {
    // "wx": never overwrite; another run may have just written the same file.
    await writeFile(file, text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

function secret(): string {
  return randomBytes(24).toString("base64url");
}

/** The instance's passwords, generated on first use. `postgres.env` doubles as the container's `--env-file`. */
export async function instanceSecrets(): Promise<InstanceSecrets> {
  const dir = configDir();
  await ensurePrivateDir(dir);
  const postgresFile = path.join(dir, "postgres.env");
  const rolesFile = path.join(dir, "roles.env");
  if (!existsSync(postgresFile)) {
    await writeEnvFile(postgresFile, { POSTGRES_USER: SUPERUSER, POSTGRES_PASSWORD: secret() });
  }
  if (!existsSync(rolesFile)) {
    await writeEnvFile(rolesFile, { ENVELOPE_APP_PASSWORD: secret(), ENVELOPE_QUEUE_PASSWORD: secret() });
  }
  const postgres = await readEnvFile(postgresFile);
  const roles = await readEnvFile(rolesFile);
  const values = [postgres.POSTGRES_USER, postgres.POSTGRES_PASSWORD, roles.ENVELOPE_APP_PASSWORD, roles.ENVELOPE_QUEUE_PASSWORD];
  if (values.some((value) => !value)) {
    throw new Error(`${dir}: postgres.env or roles.env is incomplete; remove the directory and the container to start over (scripts/README.md)`);
  }
  const [superuser, superuserPassword, appPassword, queuePassword] = values as [string, string, string, string];
  return { superuser, superuserPassword, appPassword, queuePassword };
}

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args);
  return stdout.trim();
}

async function containerState(): Promise<"running" | "stopped" | "missing"> {
  try {
    return (await docker(["inspect", "--format", "{{.State.Running}}", CONTAINER])) === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

/** The host port the container publishes 5432 on, checked to be 127.0.0.1 and not 5432. */
async function containerPort(): Promise<string> {
  const binding = (await docker(["port", CONTAINER, "5432/tcp"])).split("\n")[0] ?? "";
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  if (!match?.[1] || match[1] === SHARED_PORT) {
    throw new Error(`${CONTAINER} publishes PostgreSQL on "${binding}"; expected 127.0.0.1 on a port other than 5432`);
  }
  return match[1];
}

/**
 * The superuser connection (to its `postgres` database) of the server disposable environments
 * use. With `create`, starts the managed container, creating it first if needed; otherwise
 * returns undefined when there is no container to talk to.
 */
export async function instanceUrl(mode: "create" | "existing"): Promise<string | undefined> {
  const override = process.env.EXPLORE_DATABASE_URL;
  if (override) {
    assertExploreServerUrl(override);
    await assertDedicated(override);
    return override;
  }
  const secrets = await instanceSecrets();
  let state = await containerState();
  if (state === "missing") {
    if (mode === "existing") {
      return undefined;
    }
    const port = process.env.EXPLORE_POSTGRES_PORT ?? String(DEFAULT_PORT);
    if (!/^\d+$/.test(port) || port === SHARED_PORT) {
      throw new Error(`EXPLORE_POSTGRES_PORT must be a port number other than 5432, got "${port}"`);
    }
    try {
      await docker([
        "run", "-d",
        "--name", CONTAINER,
        "--label", "envelope-explore=instance",
        "--env-file", path.join(configDir(), "postgres.env"),
        "-p", `127.0.0.1:${port}:5432`,
        "-v", `${VOLUME}:/var/lib/postgresql/data`,
        IMAGE,
      ]);
    } catch (error) {
      // Another `up` may have created it at the same moment.
      if ((await containerState()) === "missing") {
        throw error;
      }
    }
    state = await containerState();
  }
  if (state === "stopped") {
    await docker(["start", CONTAINER]).catch(async (error: unknown) => {
      if ((await containerState()) !== "running") {
        throw error;
      }
    });
  }
  const url = new URL(`postgres://127.0.0.1:${await containerPort()}/postgres`);
  url.username = encodeURIComponent(secrets.superuser);
  url.password = encodeURIComponent(secrets.superuserPassword);
  const connection = url.toString();
  assertExploreServerUrl(connection);
  await assertDedicated(connection);
  return connection;
}

/** Waits for the server to accept connections, then refuses it if it holds the shared databases. */
async function assertDedicated(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const { rows } = await pool.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname IN ('envelope', 'keycloak')");
      if (rows.length > 0) {
        throw new Error(
          `Refusing this PostgreSQL server: it holds the ${rows.map((r) => `"${r.datname}"`).join(" and ")} database, so it is the shared development server.`,
        );
      }
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((error as Error).message.startsWith("Refusing") || code === "28P01" || Date.now() > deadline) {
        if (code === "28P01") {
          throw new Error(`The disposable environments' server refused the password in ${configDir()}. If that directory was recreated, remove the container and its volume too (scripts/README.md).`);
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await pool.end();
    }
  }
}
