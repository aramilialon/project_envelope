import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import { createEcbProvider } from "../market-data/ecb-provider.ts";
import { createFxRatesFetchHandler } from "../market-data/fx-rates-job.ts";
import { createScheduledTransaction, listScheduledTransactions } from "../scheduled-transactions/repository.ts";
import { createScheduledTransactionsFireHandler } from "../scheduled-transactions/fire-job.ts";
import { createTransaction } from "../transactions/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createBudgetRecomputeHandler } from "../notifications/budget-recompute-job.ts";
import type { PushDriver, PushOutcome, PushPayload } from "../notifications/driver.ts";
import type { PushDrivers } from "../notifications/repository.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { assertEveryJobTypeCovered, assertSingleDelivery, defineDoubleDeliveryCase, type DoubleDeliveryCase } from "./double-delivery.ts";
import { createIdempotencyKeysSweepHandler } from "../idempotency/sweep-job.ts";
import {
  ALL_JOB_TYPES,
  BUDGET_RECOMPUTE_JOB,
  FX_RATES_FETCH_JOB,
  IDEMPOTENCY_KEYS_SWEEP_JOB,
  SCHEDULED_TRANSACTIONS_FIRE_JOB,
} from "./job-types.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

/** Records every call — no real network call. */
function fakePushDriver(outcome: PushOutcome = "sent"): PushDriver & { calls: { token: string; payload: PushPayload }[] } {
  const calls: { token: string; payload: PushPayload }[] = [];
  return {
    calls,
    async send(token, payload) {
      calls.push({ token, payload });
      return outcome;
    },
  };
}

/**
 * The shared harness (#37), applied to every real job type registered so far: each one plugs
 * in its own fixture and its own way of counting "did this run's effect happen exactly once".
 * In a database of its own (#519): the `scheduled-transactions-fire` job fires every workspace
 * there is, so it must not see whatever other test files left in the shared one.
 */
describe("double-delivery harness (#37)", () => {
  let database: IsolatedDatabase | undefined;
  let superuserPool: DbPool;
  let appPool: DbPool;
  let cases: DoubleDeliveryCase[];

  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(database.databaseUrl));

    const workspace = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Test', 'EUR', 'UTC') RETURNING id",
    );
    const workspaceId = workspace.rows[0]!.id;
    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    const user = await superuserPool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email, language, locale) VALUES ($1, $2, 'en', 'en-US') RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    const userId = user.rows[0]!.id;
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, workspaceId]);
    await superuserPool.query("INSERT INTO device_tokens (user_id, platform, token) VALUES ($1, 'web', 'test-token')", [userId]);
    const tx = await createTransaction(superuserPool, {
      workspaceId,
      accountId: account.rows[0]!.id,
      occurredAt: "2026-10-01",
      splits: [{ categoryId: null, amountCents: 30_000 }],
    });

    const drivers: PushDrivers = { web: fakePushDriver(), ios: fakePushDriver(), android: fakePushDriver() };
    const budgetRecomputeCase = defineDoubleDeliveryCase({
      jobType: BUDGET_RECOMPUTE_JOB,
      data: { workspaceId, transactionId: tx.id, month: "2026-10" },
      handler: createBudgetRecomputeHandler(drivers),
      // notification_deliveries is scoped by app_user_id() (ADR 0006): a plain query on `pool`
      // has no session variables set, so it would see nothing under RLS. superuserPool is
      // exempt, and counting here needs no workspace/user scoping of its own.
      async countEffects(_pool, jobId) {
        const { rows } = await superuserPool.query<{ count: string }>(
          "SELECT count(*) FROM notification_deliveries WHERE job_id = $1",
          [jobId],
        );
        return Number(rows[0]!.count);
      },
    });
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    // A very long recurrence, so exactly one firing brings it past "today" — unlike the budget
    // month's own fixture data above, this must stay deterministic for decades, not just today.
    await createScheduledTransaction(superuserPool, {
      workspaceId,
      accountId: account.rows[0]!.id,
      payee: "Scheduled double-delivery test",
      nextDueDate: "2020-01-01",
      recurEvery: 100,
      recurUnit: "year",
      splits: [{ categoryId: category.rows[0]!.id, amountCents: 1_000 }],
    });
    const scheduledTransactionsFireCase = defineDoubleDeliveryCase({
      jobType: SCHEDULED_TRANSACTIONS_FIRE_JOB,
      data: {},
      handler: createScheduledTransactionsFireHandler({
        enqueue: async () => null,
        schedule: async () => {},
        work: async () => {},
        start: async () => {},
        stop: async () => {},
      }),
      // No job_id column on transactions (unlike notification_deliveries above): the handler
      // enumerates every workspace by itself, so a repeat delivery firing this fixture's own
      // scheduled transaction a second time is exactly the double effect this guards against —
      // counting by its own distinctive payee is enough, since nothing else in this suite's
      // workspace creates one with this name.
      async countEffects() {
        const { rows } = await superuserPool.query<{ count: string }>(
          "SELECT count(*) FROM transactions WHERE workspace_id = $1 AND payee = 'Scheduled double-delivery test'",
          [workspaceId],
        );
        return Number(rows[0]!.count);
      },
    });

    // The exchange rates fetch (#85) writes shared rows, the same on every delivery, so counting
    // rows cannot tell one delivery from two: its effect is the fetch itself, counted at the
    // fixture provider (a repeat delivery must not reach the network again).
    let fxFetches = 0;
    const fxRatesFetchCase = defineDoubleDeliveryCase({
      jobType: FX_RATES_FETCH_JOB,
      data: {},
      handler: createFxRatesFetchHandler({
        enabled: true,
        provider: createEcbProvider({
          fetchFile: async () => {
            fxFetches++;
            return readFile(new URL("../market-data/fixtures/ecb-hist.xml", import.meta.url), "utf8");
          },
        }),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      }),
      async countEffects() {
        return fxFetches;
      },
    });

    // The idempotency keys sweep (#559) deletes rows a second run would not find anyway, so counting
    // rows cannot tell one delivery from two: its effect is the run itself, counted at its log line.
    // An expired key of the fixture's workspace is there for the first run to delete.
    await superuserPool.query(
      `INSERT INTO idempotency_keys (workspace_id, key, user_id, operation, request_hash, response_status, response_body, created_at)
       VALUES ($1, $2, $3, 'test', $4, 201, '{}', now() - interval '2 days')`,
      [workspaceId, randomUUID(), userId, Buffer.alloc(32)],
    );
    const sweepRuns: Record<string, unknown>[] = [];
    const idempotencyKeysSweepCase = defineDoubleDeliveryCase({
      jobType: IDEMPOTENCY_KEYS_SWEEP_JOB,
      data: {},
      handler: createIdempotencyKeysSweepHandler(appPool, { info: (object) => sweepRuns.push(object), error: () => {} }),
      async countEffects() {
        const { rows } = await superuserPool.query<{ count: string }>("SELECT count(*) FROM idempotency_keys WHERE workspace_id = $1", [
          workspaceId,
        ]);
        assert.equal(Number(rows[0]!.count), 0, "the expired key is gone");
        assert.deepEqual(sweepRuns, [{ workspaces: 1, deleted: 1 }]);
        return sweepRuns.length;
      },
    });

    cases = [budgetRecomputeCase, scheduledTransactionsFireCase, fxRatesFetchCase, idempotencyKeysSweepCase];
  });

  after(async () => {
    try {
      await appPool?.end();
      await superuserPool?.end();
    } finally {
      await database?.drop();
    }
  });

  it("covers every registered job type", () => {
    assertEveryJobTypeCovered(ALL_JOB_TYPES, cases);
  });

  it("delivers each registered job type's effects exactly once, even when redelivered", async () => {
    for (const testCase of cases) {
      await assertSingleDelivery(appPool, testCase);
    }
  });
});
