import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createTransaction } from "../transactions/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createBudgetRecomputeHandler } from "../notifications/budget-recompute-job.ts";
import type { PushDriver, PushOutcome, PushPayload } from "../notifications/driver.ts";
import type { PushDrivers } from "../notifications/repository.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { assertEveryJobTypeCovered, assertSingleDelivery, defineDoubleDeliveryCase, type DoubleDeliveryCase } from "./double-delivery.ts";
import { ALL_JOB_TYPES, BUDGET_RECOMPUTE_JOB } from "./job-types.ts";

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
 */
describe("double-delivery harness (#37)", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let cases: DoubleDeliveryCase[];

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));

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
    cases = [budgetRecomputeCase];
  });

  after(async () => {
    await appPool.end();
    await superuserPool.end();
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
