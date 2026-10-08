import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { processJob } from "../queue/postgres-driver.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { listTransactionsForAccount } from "../transactions/repository.ts";
import { createScheduledTransactionsFireHandler } from "./fire-job.ts";
import { listScheduledTransactions } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

/**
 * Exercises the real `envelope_app`-scoped connection (ADR 0006), not the superuser one
 * `repository.test.ts`'s own tests use: this is the one test proving `app_is_system_job()`
 * (ADR 0010, migration 0023) actually lets the handler enumerate every workspace, across more
 * than one, rather than only the repository function it calls once a workspace is already known.
 */
describe("createScheduledTransactionsFireHandler (#38)", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let workspaceA: string;
  let workspaceB: string;
  let accountA: string;
  let accountB: string;
  let scheduledA: string;
  let scheduledB: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));

    async function makeWorkspace(
      name: string,
      nextDueDate: string,
    ): Promise<{ workspaceId: string; accountId: string; scheduledId: string }> {
      const workspace = await superuserPool.query<{ id: string }>(
        "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ($1, 'EUR', 'UTC') RETURNING id",
        [name],
      );
      const workspaceId = workspace.rows[0]!.id;
      const account = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
        [workspaceId],
      );
      const group = await superuserPool.query<{ id: string }>(
        "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
        [workspaceId],
      );
      const category = await superuserPool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 1) RETURNING id",
        [workspaceId, group.rows[0]!.id],
      );
      const scheduled = await superuserPool.query<{ id: string }>(
        `INSERT INTO scheduled_transactions (workspace_id, account_id, payee, next_due_date, recur_every, recur_unit)
         VALUES ($1, $2, $3, $4::date, 1, 'month') RETURNING id`,
        [workspaceId, account.rows[0]!.id, `Rent ${name}`, nextDueDate],
      );
      const scheduledId = scheduled.rows[0]!.id;
      await superuserPool.query(
        "INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, 1000)",
        [workspaceId, scheduledId, category.rows[0]!.id],
      );
      return { workspaceId, accountId: account.rows[0]!.id, scheduledId };
    }

    // A fixed, long-past due date: always overdue whenever this test actually runs, so the
    // assertions below never depend on today's own real date — only on "has it fired at least
    // once". Two separate workspaces, so the handler enumerating only one (a bug in the RLS
    // allowance, or in the loop itself) would be caught.
    const a = await makeWorkspace("Fire A", "2026-09-01");
    const b = await makeWorkspace("Fire B", "2026-09-01");
    workspaceA = a.workspaceId;
    accountA = a.accountId;
    scheduledA = a.scheduledId;
    workspaceB = b.workspaceId;
    accountB = b.accountId;
    scheduledB = b.scheduledId;
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA, workspaceB]]);
    await appPool.end();
    await superuserPool.end();
  });

  it("fires every due scheduled transaction in every workspace, not only the first", async () => {
    const handler = createScheduledTransactionsFireHandler({
      enqueue: async () => null,
      schedule: async () => {},
      work: async () => {},
      start: async () => {},
      stop: async () => {},
    });
    await processJob(appPool, "scheduled-transactions-fire-test", randomUUID(), {}, handler);

    const [recordedA, recordedB, transactionsA, transactionsB] = await Promise.all([
      listScheduledTransactions(superuserPool, workspaceA),
      listScheduledTransactions(superuserPool, workspaceB),
      listTransactionsForAccount(superuserPool, workspaceA, accountA),
      listTransactionsForAccount(superuserPool, workspaceB, accountB),
    ]);
    assert.notEqual(recordedA.find((t) => t.id === scheduledA)?.nextDueDate, "2026-09-01");
    assert.notEqual(recordedB.find((t) => t.id === scheduledB)?.nextDueDate, "2026-09-01");
    assert.ok(transactionsA.some((t) => t.payee === "Rent Fire A" && t.budgetDate === "2026-09-01"));
    assert.ok(transactionsB.some((t) => t.payee === "Rent Fire B" && t.budgetDate === "2026-09-01"));
  });
});
