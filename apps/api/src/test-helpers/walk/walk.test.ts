/**
 * The seeded model-based random walk through the API (#80, ADR 0013). In CI it runs a few fixed
 * seeds for a few hundred steps each through `inject`, and one short walk through `fetch` against
 * the real server process. On demand:
 *
 *   WALK_SEED=1234 WALK_STEPS=5000 node --test src/test-helpers/walk/walk.test.ts   # a long run
 *   WALK_REPLAY=/tmp/envelope-walk-….json node --test src/test-helpers/walk/walk.test.ts
 *   WALK_DRIVER=fetch                                                              # through the real process
 *
 * A failure prints the seed, the step and the path of the operation log it wrote.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildApp, type App } from "../../app.ts";
import { loadConfig } from "../../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../../db/migrate.ts";
import { createPool, type DbPool } from "../../db/pool.ts";
import { startServer, type RunningServer } from "../../smoke/support.ts";
import { appConnectionString, ensureAppRoleLogin } from "../app-role.ts";
import { requireIntegrationTestEnv } from "../integration-setup.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../keycloak.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../queue-role.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../vapid-keys.ts";
import { fetchDriver, injectDriver, type WalkDriver } from "./driver.ts";
import { createWalkUsers, runWalk, type WalkEnvironment, type WalkLog, type WalkResult } from "./run.ts";

/**
 * The seeds CI walks every time; a seed that once failed joins them once its bug is fixed. Two
 * seeds of 300 steps (about 22–33 s each), the determinism check and the short walk through the
 * real process take the file to about 60–85 s on a development machine, depending on its load
 * (#80): a third seed would add another 25 s or so.
 */
const CI_SEEDS = [1, 20261120];
const CI_STEPS = 300;
/** The walk through the real process only proves the `fetch` driver and the process; it stays short. */
const FETCH_STEPS = 60;
/**
 * Two walks of the same seed must give byte-identical logs; a short one is enough to show it, as
 * long as it creates trades of more than one row, whose order ties on random ids. Seed 1 creates
 * none in its first 60 steps; seed 20261120 splits at step 54 and transfers securities with a fee
 * at step 60, whose cash leg's handle lands in the log after the outgoing leg's.
 */
const DETERMINISM_SEED = 20261120;
const DETERMINISM_STEPS = 60;

const { databaseUrl } = requireIntegrationTestEnv();

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be an integer, got ${value}`);
  return number;
}

function report(result: WalkResult, driver: string): void {
  const kinds = Object.entries(result.byKind)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, [accepted, refused]]) => `${kind} ${accepted}/${refused}`)
    .join(", ");
  console.log(
    `walk seed ${result.seed} (${driver}): ${result.steps} steps, ${result.accepted} accepted, ${result.refused} refused, ` +
      `${(result.durationMs / 1000).toFixed(1)} s\n  accepted/refused by operation: ${kinds}`,
  );
}

describe("random walk through the API (#80, ADR 0013)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let server: RunningServer | undefined;
  let env: WalkEnvironment;

  const replay = process.env.WALK_REPLAY ? (JSON.parse(readFileSync(process.env.WALK_REPLAY, "utf8")) as WalkLog) : undefined;
  const seed = numberFromEnv("WALK_SEED");
  const steps = numberFromEnv("WALK_STEPS");
  const onDemand = replay !== undefined || seed !== undefined;
  const logDir = process.env.WALK_LOG_DIR;

  async function environment(driver: WalkDriver): Promise<WalkEnvironment> {
    return { driver, superuserPool, users: await createWalkUsers(realm, driver) };
  }

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
      }),
    );
    env = await environment(injectDriver(app));
  });

  after(async () => {
    await stopRealServer();
    await app.close();
    await realm.teardown();
    await superuserPool.end();
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
    });
    return fetchDriver(server.baseUrl);
  }

  /** The same users and database, through a real server process instead of `inject`. */
  async function fetchEnvironment(): Promise<WalkEnvironment> {
    return { ...env, driver: await startRealServer() };
  }

  /**
   * Stops the real server and drops the `budget-recompute` jobs its writes queued for workspaces
   * the walk has since deleted. The server works through them one at a time, so a walk leaves a
   * backlog behind; the next test file that starts a worker on that queue in this database would
   * have to get through it first, and a test waiting a few seconds for its own job would time out
   * (#80: `transactions/repository.test.ts` did).
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

  async function walkEnvironment(): Promise<WalkEnvironment> {
    return process.env.WALK_DRIVER === "fetch" ? fetchEnvironment() : env;
  }

  if (onDemand) {
    it(replay ? `replays ${process.env.WALK_REPLAY}` : `walks seed ${seed} for ${steps ?? CI_STEPS} steps`, { timeout: Infinity }, async () => {
      const chosen = await walkEnvironment();
      try {
        const result = await runWalk(chosen, {
          ...(replay ? { seed: replay.seed, steps: replay.ops.length, replay } : { seed: seed!, steps: steps ?? CI_STEPS }),
          ...(logDir ? { logDir } : {}),
        });
        report(result, chosen.driver.name);
        if (process.env.WALK_SAVE_LOG === "1") {
          // A walk that passed keeps its log too, to compare two runs of one seed (they must match).
          const file = join(logDir ?? tmpdir(), `envelope-walk-seed${result.seed}-passed-${process.pid}-${Date.now()}.json`);
          writeFileSync(file, `${JSON.stringify(result.log, null, 1)}\n`);
          console.log(`operation log: ${file}`);
        }
      } finally {
        await stopRealServer();
      }
    });
    return;
  }

  for (const ciSeed of CI_SEEDS) {
    it(`keeps every invariant for seed ${ciSeed}, ${CI_STEPS} steps (inject)`, async () => {
      report(await runWalk(env, { seed: ciSeed, steps: CI_STEPS, ...(logDir ? { logDir } : {}) }), "inject");
    });
  }

  it(`walks seed ${DETERMINISM_SEED} the same way twice, ${DETERMINISM_STEPS} steps (inject)`, async () => {
    // A seed is a reproduction only if it gives the same walk every time: every operation, every
    // status and every handle given out, whatever ids and creation times the API picks. The rows of
    // one split or securities transfer come back in an order that ties on their random ids, so
    // this seed also checks the order the model gives them handles in (`sortTradeRows`), though
    // only when the two walks happen to get the rows back in different orders (about one run in
    // two); model.test.ts checks that order every time.
    const first = await runWalk(env, { seed: DETERMINISM_SEED, steps: DETERMINISM_STEPS, ...(logDir ? { logDir } : {}) });
    const second = await runWalk(env, { seed: DETERMINISM_SEED, steps: DETERMINISM_STEPS, ...(logDir ? { logDir } : {}) });
    const firstLog = JSON.stringify(first.log.ops);
    const secondLog = JSON.stringify(second.log.ops);
    if (firstLog !== secondLog) {
      const step = first.log.ops.findIndex((op, index) => JSON.stringify(op) !== JSON.stringify(second.log.ops[index]));
      assert.fail(`seed ${DETERMINISM_SEED} walked differently the second time, from step ${step + 1}:\n  ${JSON.stringify(first.log.ops[step])}\n  ${JSON.stringify(second.log.ops[step])}`);
    }
  });

  it(`keeps every invariant through the real process, seed ${CI_SEEDS[0]}, ${FETCH_STEPS} steps (fetch)`, async () => {
    const fetchEnv = await fetchEnvironment();
    try {
      report(await runWalk(fetchEnv, { seed: CI_SEEDS[0]!, steps: FETCH_STEPS, ...(logDir ? { logDir } : {}) }), "fetch");
    } finally {
      await stopRealServer();
    }
  });
});
