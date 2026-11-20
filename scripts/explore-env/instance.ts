/**
 * The PostgreSQL server disposable environments use (#536): a server of their own, never the
 * shared development one. `envelope_app` and `envelope_queue` are cluster-wide roles, so a run's
 * API credentials on the shared server would also open the shared `envelope` database; on a
 * dedicated server they open nothing but that run's own database (`postgres.ts`: per-run login
 * roles, CONNECT granted only on their own database).
 *
 * Locally that server is a container this tool manages, `envelope-explore-postgres` (postgres:17,
 * bound to 127.0.0.1 on port 55432 by default, `EXPLORE_POSTGRES_PORT` to change it, data in the
 * `envelope-explore-postgres-data` volume). Its superuser password is generated once into
 * `~/.config/envelope-explore/postgres-password` (`$XDG_CONFIG_HOME` if set), outside the
 * repository, and reaches the container as `POSTGRES_PASSWORD_FILE` through a read-only bind
 * mount, so `docker inspect` never shows it. In CI, `EXPLORE_DATABASE_URL` names a server the
 * workflow provides instead, and no container is managed.
 *
 * Whatever names the server, it must be local, on an explicit port other than 5432, and must not
 * hold an `envelope` or `keycloak` database: the shared server is refused however it is reached.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv, promisify } from "node:util";

import pg from "pg";

import { ensurePrivateDir } from "./private-dir.ts";

const run = promisify(execFile);

export const CONTAINER = "envelope-explore-postgres";
export const VOLUME = "envelope-explore-postgres-data";
export const DEFAULT_PORT = 55432;
export const SUPERUSER = "explore_admin";
export const PASSWORD_FILE = "postgres-password";
const SECRET_IN_CONTAINER = "/run/secrets/envelope-explore-postgres-password";
const IMAGE = "postgres:17";
const SHARED_PORT = "5432";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
const READY_TIMEOUT_MS = 60_000;

export function configDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "envelope-explore");
}

/**
 * Refuses a server URL that is not local, has no explicit port, or uses 5432 (the shared
 * server's port). Pure, so it is tested on its own (`guards.test.ts`).
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

/**
 * The password file is read-only (0444) rather than 0600: the container's entrypoint reads it as
 * the image's own `postgres` user, not as its owner. Nobody else on the host can reach it, because
 * its directory is 0700 and ours (`ensurePrivateDir`); here it must be ours, a regular file, and
 * not writable by anyone.
 */
async function assertPasswordFile(file: string): Promise<void> {
  const info = await lstat(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o444) {
    throw new Error(`Refusing ${file}: expected a regular file of ours with mode 444`);
  }
}

/** The superuser password, generated on first use (or carried over from an earlier `postgres.env`). */
export async function superuserPassword(): Promise<string> {
  const dir = configDir();
  await ensurePrivateDir(dir);
  const file = path.join(dir, PASSWORD_FILE);
  if (!existsSync(file)) {
    // An instance set up before #536's re-review kept the password in postgres.env, read by
    // `docker run --env-file`; it carries over, so the existing volume still opens.
    const legacy = path.join(dir, "postgres.env");
    const carried = existsSync(legacy) ? parseEnv(await readFile(legacy, "utf8")).POSTGRES_PASSWORD : undefined;
    try {
      await writeFile(file, carried ?? randomBytes(24).toString("base64url"), { mode: 0o444, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    await chmod(file, 0o444);
  }
  await assertPasswordFile(file);
  await rm(path.join(dir, "postgres.env"), { force: true });
  await rm(path.join(dir, "roles.env"), { force: true });
  const password = (await readFile(file, "utf8")).trim();
  if (!password) {
    throw new Error(`${file} is empty; remove the directory and the container to start over (scripts/README.md)`);
  }
  return password;
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

/** True when the container still carries its password as a plain environment variable (the old `--env-file` setup). */
async function containerHasPasswordInEnv(): Promise<boolean> {
  const env = JSON.parse(await docker(["inspect", "--format", "{{json .Config.Env}}", CONTAINER])) as string[];
  return env.some((entry) => entry.startsWith("POSTGRES_PASSWORD="));
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

async function createContainer(port: string): Promise<void> {
  if (!/^\d+$/.test(port) || port === SHARED_PORT) {
    throw new Error(`EXPLORE_POSTGRES_PORT must be a port number other than 5432, got "${port}"`);
  }
  try {
    await docker([
      "run", "-d",
      "--name", CONTAINER,
      "--label", "envelope-explore=instance",
      "-e", `POSTGRES_USER=${SUPERUSER}`,
      "-e", `POSTGRES_PASSWORD_FILE=${SECRET_IN_CONTAINER}`,
      "-v", `${path.join(configDir(), PASSWORD_FILE)}:${SECRET_IN_CONTAINER}:ro`,
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
}

/**
 * The superuser connection (to its `postgres` database) of the server disposable environments
 * use. With `create`, starts the managed container, creating it first if needed (and recreating
 * one from the old `--env-file` setup on its same volume and port); otherwise returns undefined
 * when there is no container to talk to.
 */
export async function instanceUrl(mode: "create" | "existing"): Promise<string | undefined> {
  const override = process.env.EXPLORE_DATABASE_URL;
  if (override) {
    assertExploreServerUrl(override);
    await assertDedicated(override);
    return override;
  }
  const password = await superuserPassword();
  let state = await containerState();
  if (state !== "missing" && (await containerHasPasswordInEnv())) {
    const port = await containerPort();
    await docker(["rm", "-f", CONTAINER]);
    await createContainer(port);
    state = await containerState();
  }
  if (state === "missing") {
    if (mode === "existing") {
      return undefined;
    }
    await createContainer(process.env.EXPLORE_POSTGRES_PORT ?? String(DEFAULT_PORT));
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
  url.username = encodeURIComponent(SUPERUSER);
  url.password = encodeURIComponent(password);
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
