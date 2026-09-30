import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createTransaction } from "../transactions/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { processJob } from "../queue/postgres-driver.ts";
import { BUDGET_RECOMPUTE_JOB, type BudgetRecomputeJobData } from "../queue/job-types.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createBudgetRecomputeHandler } from "./budget-recompute-job.ts";
import type { PushDriver, PushOutcome, PushPayload } from "./driver.ts";
import type { PushDrivers } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

/** Records every call, and returns whatever outcome the test configured for it — no real network call. */
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

describe("createBudgetRecomputeHandler (#40)", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let workspaceId: string;
  let accountId: string;
  let userId: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));

    const workspace = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Test', 'EUR', 'UTC') RETURNING id",
    );
    workspaceId = workspace.rows[0]!.id;
    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const user = await superuserPool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email, language, locale) VALUES ($1, $2, 'en', 'en-US') RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    userId = user.rows[0]!.id;
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, workspaceId]);
    await superuserPool.query("INSERT INTO device_tokens (user_id, platform, token) VALUES ($1, 'web', 'test-token')", [userId]);
  });

  after(async () => {
    await appPool.end();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await superuserPool.query("DELETE FROM users WHERE id = $1", [userId]);
    await superuserPool.end();
  });

  function driversFor(webDriver: PushDriver & { calls: unknown[] }): PushDrivers {
    return { web: webDriver, ios: fakePushDriver(), android: fakePushDriver() };
  }

  it("notifies every workspace member when money arrives to assign", async () => {
    const month = "2026-06";
    const tx = await createTransaction(superuserPool, {
      workspaceId,
      accountId,
      occurredAt: "2026-06-01",
      splits: [{ categoryId: null, amountCents: 50_000 }],
    });
    const webDriver = fakePushDriver();
    const handler = createBudgetRecomputeHandler(driversFor(webDriver));
    const data: BudgetRecomputeJobData = { workspaceId, transactionId: tx.id, month };

    await processJob(appPool, BUDGET_RECOMPUTE_JOB, randomUUID(), data, handler);

    assert.equal(webDriver.calls.length, 1);
    assert.match(webDriver.calls[0]!.payload.body, /is ready to be assigned/);
  });

  it("does not notify again while the same problem persists unchanged", async () => {
    const month = "2026-07";
    const tx = await createTransaction(superuserPool, {
      workspaceId,
      accountId,
      occurredAt: "2026-07-01",
      splits: [{ categoryId: null, amountCents: 20_000 }],
    });
    const webDriver = fakePushDriver();
    const handler = createBudgetRecomputeHandler(driversFor(webDriver));
    const data: BudgetRecomputeJobData = { workspaceId, transactionId: tx.id, month };

    await processJob(appPool, BUDGET_RECOMPUTE_JOB, randomUUID(), data, handler);
    // A second, independently triggered run for the same month, nothing having changed.
    await processJob(appPool, BUDGET_RECOMPUTE_JOB, randomUUID(), data, handler);

    assert.equal(webDriver.calls.length, 1, "an unchanged problem must not be notified a second time");
  });

  it("notifies again once the same problem's amount changes", async () => {
    const month = "2026-08";
    const tx1 = await createTransaction(superuserPool, {
      workspaceId,
      accountId,
      occurredAt: "2026-08-01",
      splits: [{ categoryId: null, amountCents: 10_000 }],
    });
    const webDriver = fakePushDriver();
    const handler = createBudgetRecomputeHandler(driversFor(webDriver));

    await processJob(appPool, BUDGET_RECOMPUTE_JOB, randomUUID(), { workspaceId, transactionId: tx1.id, month }, handler);
    assert.equal(webDriver.calls.length, 1);

    const tx2 = await createTransaction(superuserPool, {
      workspaceId,
      accountId,
      occurredAt: "2026-08-15",
      splits: [{ categoryId: null, amountCents: 5_000 }],
    });
    await processJob(appPool, BUDGET_RECOMPUTE_JOB, randomUUID(), { workspaceId, transactionId: tx2.id, month }, handler);

    assert.equal(webDriver.calls.length, 2, "an amount change must be notified again, even in the same month");
  });

  it("sends nothing when the month has no budget problems", async () => {
    // Its own workspace, never touched by another test: `unassigned` is cumulative across
    // months (packages/core's computeBudgetMonth), so reusing the shared one here would
    // carry forward the other tests' own unassigned income.
    const workspace = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Empty', 'EUR', 'UTC') RETURNING id",
    );
    const emptyWorkspaceId = workspace.rows[0]!.id;
    const webDriver = fakePushDriver();
    const handler = createBudgetRecomputeHandler(driversFor(webDriver));

    await processJob(
      appPool,
      BUDGET_RECOMPUTE_JOB,
      randomUUID(),
      { workspaceId: emptyWorkspaceId, transactionId: randomUUID(), month: "2026-09" },
      handler,
    );

    assert.equal(webDriver.calls.length, 0);
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [emptyWorkspaceId]);
  });
});
