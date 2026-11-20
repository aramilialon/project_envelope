/**
 * The names a disposable environment uses, and the checks that keep it away from everything
 * else on the server (#536). Every database and realm this tool creates or removes goes through
 * `databaseName`/`realmName` (which build a name from a validated run id) or through
 * `assertExploreDatabase`/`assertExploreRealm` (which check a name read from somewhere else: a
 * manifest, the server's own list). The shared `envelope` database and realm, and Keycloak's own
 * `keycloak` database, are refused by name as well as by prefix.
 */
import { randomBytes } from "node:crypto";

export const DATABASE_PREFIX = "envelope_explore_";
export const REALM_PREFIX = "envelope-explore-";

/** Names this tool must never create, change or remove, whatever else the checks say. */
const NEVER_TOUCHED = new Set(["envelope", "keycloak", "master", "postgres", "template0", "template1"]);

const RUN_ID = /^[0-9a-f]{8}$/;

/** A short random run id: 8 lowercase hex digits. */
export function newRunId(): string {
  return randomBytes(4).toString("hex");
}

export function assertRunId(run: string): void {
  if (!RUN_ID.test(run)) {
    throw new Error(`Not a run id: "${run}" (expected 8 lowercase hex digits)`);
  }
}

export function databaseName(run: string): string {
  assertRunId(run);
  return `${DATABASE_PREFIX}${run}`;
}

export function realmName(run: string): string {
  assertRunId(run);
  return `${REALM_PREFIX}${run}`;
}

/** The run id a database or realm name belongs to, or undefined when the name is not one of ours. */
export function runOf(name: string): string | undefined {
  for (const prefix of [DATABASE_PREFIX, REALM_PREFIX]) {
    if (name.startsWith(prefix)) {
      const run = name.slice(prefix.length);
      return RUN_ID.test(run) ? run : undefined;
    }
  }
  return undefined;
}

export function assertExploreDatabase(name: string): void {
  if (NEVER_TOUCHED.has(name) || !name.startsWith(DATABASE_PREFIX) || runOf(name) === undefined) {
    throw new Error(`Refusing to touch database "${name}": only ${DATABASE_PREFIX}<run> databases are disposable`);
  }
}

export function assertExploreRealm(name: string): void {
  if (NEVER_TOUCHED.has(name) || !name.startsWith(REALM_PREFIX) || runOf(name) === undefined) {
    throw new Error(`Refusing to touch realm "${name}": only ${REALM_PREFIX}<run> realms are disposable`);
  }
}

/** The database a PostgreSQL connection string points at. */
export function databaseOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}

/** The realm an issuer URL (`<keycloak>/realms/<realm>`) names. */
export function realmOfIssuer(issuer: string): string {
  const match = /\/realms\/([^/]+)\/?$/.exec(new URL(issuer).pathname);
  if (!match?.[1]) {
    throw new Error(`Not a Keycloak issuer URL: ${issuer}`);
  }
  return decodeURIComponent(match[1]);
}

/**
 * Checks the environment a disposable API or web build is about to get: its issuer must name
 * this run's realm and its database connections this run's database, so a variable copied from
 * a developer's own `.env` can never point it at the shared `envelope` realm or database.
 */
export function assertEnvTargetsRun(env: Readonly<Record<string, string | undefined>>, run: string): void {
  const realm = realmName(run);
  const database = databaseName(run);
  for (const name of ["KEYCLOAK_ISSUER", "VITE_KEYCLOAK_ISSUER"]) {
    const value = env[name];
    if (value !== undefined && realmOfIssuer(value) !== realm) {
      throw new Error(`Refusing to start: ${name} names realm "${realmOfIssuer(value)}", not this run's "${realm}"`);
    }
  }
  for (const name of ["DATABASE_URL", "APP_DATABASE_URL", "QUEUE_DATABASE_URL"]) {
    const value = env[name];
    if (value !== undefined && databaseOf(value) !== database) {
      throw new Error(`Refusing to start: ${name} names database "${databaseOf(value)}", not this run's "${database}"`);
    }
  }
}
