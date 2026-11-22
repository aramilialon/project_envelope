/**
 * The setup every random-walk test file shares (#80, ADR 0013), and the fixed CI walks.
 *
 * The walks CI runs are split into one file per seed or check (#638, ADR 0016): `seed-1.test.ts`,
 * `seed-20261120.test.ts`, `determinism.test.ts`, `regressions.test.ts` and `fetch.test.ts`, so
 * `node --test` runs them alongside each other and alongside every other integration test file,
 * and no single file holds up the end of the run. `walk.test.ts` runs a walk on demand only
 * (`WALK_SEED`, `WALK_REPLAY`). Each file calls `useWalkSuite()` once, inside its `describe`, and
 * gets its own app, its own Keycloak realm and its own users and workspaces: no file depends on
 * another having run, or on running alone.
 */
import { join } from "node:path";
import { after, afterEach, before } from "node:test";

import { buildApp, type App } from "../../app.ts";
import { loadConfig } from "../../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../../db/migrate.ts";
import { createPool, type DbPool } from "../../db/pool.ts";
import { printServerOutputOnFailure, startServer, type RunningServer } from "../../smoke/support.ts";
import { appConnectionString, ensureAppRoleLogin } from "../app-role.ts";
import { requireIntegrationTestEnv } from "../integration-setup.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../keycloak.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../queue-role.ts";
import { HIGH_RATE_LIMITS_ENV } from "../rate-limits.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../vapid-keys.ts";
import { fetchDriver, injectDriver, type WalkDriver } from "./driver.ts";
import { createWalkUsers, type WalkEnvironment, type WalkOptions, type WalkResult } from "./run.ts";

/**
 * How far CI walks each of its fixed seeds. Every seed CI walks has a file of its own,
 * `seed-<seed>.test.ts` (seeds 1 and 20261120 today); a seed that once failed joins them, with a
 * file of its own, once its bug is fixed. A seed of 300 steps takes about 22–33 s on a
 * development machine, depending on its load (#80).
 */
export const CI_STEPS = 300;
/** The walk through the real process only proves the `fetch` driver and the process; it stays short. */
export const FETCH_SEED = 1;
export const FETCH_STEPS = 60;
/**
 * Two walks of the same seed must give byte-identical logs; a short one is enough to show it, as
 * long as it creates trades of more than one row, whose order ties on random ids. Seed 1 creates
 * none in its first 60 steps; seed 20261120 splits at step 54 and transfers securities with a fee
 * at step 60, whose cash leg's handle lands in the log after the outgoing leg's.
 */
export const DETERMINISM_SEED = 20261120;
export const DETERMINISM_STEPS = 60;

/** The minimal logs of the bugs the walk found, one per issue (README, "The random walk"). */
export const REGRESSIONS_DIR = join(import.meta.dirname, "regressions");

/** Where a failing walk writes its log: `WALK_LOG_DIR`, or the system's temporary directory. */
export function logOptions(): Pick<WalkOptions, "logDir"> {
  const logDir = process.env.WALK_LOG_DIR;
  return logDir ? { logDir } : {};
}

export function report(result: WalkResult, driver: string): void {
  const kinds = Object.entries(result.byKind)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, [accepted, refused]]) => `${kind} ${accepted}/${refused}`)
    .join(", ");
  console.log(
    `walk seed ${result.seed} (${driver}): ${result.steps} steps, ${result.accepted} accepted, ${result.refused} refused, ` +
      `${(result.durationMs / 1000).toFixed(1)} s\n  accepted/refused by operation: ${kinds}`,
  );
}

export interface WalkSuite {
  /** The users and the database, through `inject`; set once the `before` hook has run. */
  readonly env: () => WalkEnvironment;
  /** The same users and database, through a real server process instead of `inject`. */
  readonly fetchEnvironment: () => Promise<WalkEnvironment>;
  /** Stops the real server `fetchEnvironment` started, if any (see below). */
  readonly stopRealServer: () => Promise<void>;
}

/**
 * Registers the `before`, `afterEach` and `after` hooks of a walk file in the current `describe`:
 * the database migrated, the run's app login, a Keycloak realm of the file's own, an app built
 * against both, and a user per persona and role. Call it once per file, at the top of its
 * `describe`.
 */
export function useWalkSuite(): WalkSuite {
  const { databaseUrl } = requireIntegrationTestEnv();
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let env: WalkEnvironment | undefined;
  let server: RunningServer | undefined;
  /** The real server a test started, kept after it stops so a failed test can print its output. */
  let lastServer: RunningServer | undefined;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();
    app = buildApp(
      loadConfig({
        ...process.env,
        // A walk sends thousands of requests, many refused on purpose: only warnings and errors.
        LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
        ...HIGH_RATE_LIMITS_ENV,
      }),
    );
    const driver = injectDriver(app);
    env = { driver, superuserPool, users: await createWalkUsers(realm, driver) };
  });

  afterEach((context) => {
    printServerOutputOnFailure(() => [lastServer])(context);
    lastServer = undefined;
  });

  after(async () => {
    await stopRealServer();
    await app?.close();
    await realm?.teardown();
    await superuserPool?.end();
  });

  async function startRealServer(): Promise<WalkDriver> {
    await ensureQueueRoleLogin(superuserPool);
    server = await startServer({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      ...HIGH_RATE_LIMITS_ENV,
    });
    lastServer = server;
    return fetchDriver(server.baseUrl);
  }

  /**
   * Stops the real server and drops the `budget-recompute` jobs its writes queued for workspaces
   * the walk has since deleted. The server works through them one at a time, so a walk leaves a
   * backlog behind; a test file that starts a worker on that queue in this database would have to
   * get through it first, and a test waiting a few seconds for its own job would time out (#80:
   * `transactions/repository.test.ts` did).
   */
  async function stopRealServer(): Promise<void> {
    if (!server) return;
    await server.stop();
    server = undefined;
    await superuserPool.query(
      `DELETE FROM pgboss.job j
       WHERE j.name = 'budget-recompute' AND j.state IN ('created', 'retry', 'active')
         AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id::text = j.data->>'workspaceId')`,
    );
  }

  function currentEnv(): WalkEnvironment {
    if (!env) throw new Error("the walk suite's before hook has not run");
    return env;
  }

  return {
    env: currentEnv,
    fetchEnvironment: async () => ({ ...currentEnv(), driver: await startRealServer() }),
    stopRealServer,
  };
}
