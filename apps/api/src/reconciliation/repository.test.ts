import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createTransaction, getTransaction } from "../transactions/repository.ts";
import { getReconciliationCandidates, reconcileAccount, unlockReconciledTransaction } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("reconciliation repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let accountId: string;
  let categoryId: string;
  let userId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
    const user = await pool.query<{ id: string }>("INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id", [
      randomUUID(),
      `${randomUUID()}@example.com`,
    ]);
    userId = user.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("lists pending and cleared candidates up to the given date, with no prior reconciliation", async () => {
    const cleared = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-01-05",
      status: "cleared",
      splits: [{ categoryId, amountCents: -1000 }],
    });
    const pending = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-01-06",
      status: "pending",
      splits: [{ categoryId, amountCents: -500 }],
    });
    const future = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-02-01",
      status: "cleared",
      splits: [{ categoryId, amountCents: -200 }],
    });

    const candidates = await getReconciliationCandidates(pool, workspaceId, accountId, "2026-01-31");
    assert.equal(candidates.lastReconciledBalanceCents, 0);
    assert.ok(candidates.clearedTransactions.some((t) => t.id === cleared.id));
    assert.ok(candidates.pendingTransactions.some((t) => t.id === pending.id));
    assert.ok(!candidates.clearedTransactions.some((t) => t.id === future.id));
  });

  it("reconciles when the ticked total matches the statement balance exactly", async () => {
    const workspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspace]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspace],
    );
    const acct = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspace],
    );
    const cat = (
      await pool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 1) RETURNING id",
        [workspace, group.rows[0]!.id],
      )
    ).rows[0]!.id;
    const a = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-03-01",
      status: "cleared",
      splits: [{ categoryId: null, amountCents: 100000 }],
    });
    const b = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-03-02",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -2500 }],
    });

    const result = await reconcileAccount(pool, workspace, {
      accountId: acct,
      date: "2026-03-31",
      statementBalanceCents: 97500,
      tickedTransactionIds: [a.id, b.id],
      userId,
    });
    assert.equal(result.outcome, "reconciled");
    if (result.outcome !== "reconciled") return;
    assert.equal(result.reconciliation.statementBalanceCents, 97500);

    const reconciledA = await getTransaction(pool, workspace, a.id);
    assert.equal(reconciledA?.status, "reconciled");

    // A second reconciliation later builds on the first one's statement balance, not zero.
    const c = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-04-05",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -1000 }],
    });
    const second = await reconcileAccount(pool, workspace, {
      accountId: acct,
      date: "2026-04-30",
      statementBalanceCents: 96500,
      tickedTransactionIds: [c.id],
      userId,
    });
    assert.equal(second.outcome, "reconciled");
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace]);
  });

  it("reports the difference with no suggestion when nothing explains it", async () => {
    const a = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-05-01",
      status: "cleared",
      splits: [{ categoryId, amountCents: -1000 }],
    });

    const result = await reconcileAccount(pool, workspaceId, {
      accountId,
      date: "2026-05-31",
      statementBalanceCents: -12345,
      tickedTransactionIds: [a.id],
      userId,
    });
    assert.equal(result.outcome, "difference");
    if (result.outcome !== "difference") return;
    assert.equal(result.suggestion, undefined);
  });

  it("suggests a pending transaction whose amount equals the difference", async () => {
    const workspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspace]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspace],
    );
    const acct = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspace],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 1) RETURNING id",
      [workspace, group.rows[0]!.id],
    );
    const cat = category.rows[0]!.id;

    const cleared = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-06-01",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -1000 }],
    });
    const pending = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-06-15",
      status: "pending",
      splits: [{ categoryId: cat, amountCents: -750 }],
    });

    const result = await reconcileAccount(pool, workspace, {
      accountId: acct,
      date: "2026-06-30",
      statementBalanceCents: -1750, // -1000 (ticked) - 750 (the pending one, not yet ticked)
      tickedTransactionIds: [cleared.id],
      userId,
    });
    assert.equal(result.outcome, "difference");
    if (result.outcome !== "difference") return;
    assert.equal(result.differenceCents, -750);
    assert.deepEqual(result.suggestion, { transactionId: pending.id, kind: "pending" });
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace]);
  });

  it("suggests an unticked cleared transaction whose amount equals the difference", async () => {
    const workspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspace]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspace],
    );
    const acct = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspace],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 1) RETURNING id",
      [workspace, group.rows[0]!.id],
    );
    const cat = category.rows[0]!.id;

    const ticked = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-07-01",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -1000 }],
    });
    const forgotten = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-07-10",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -300 }],
    });

    const result = await reconcileAccount(pool, workspace, {
      accountId: acct,
      date: "2026-07-31",
      statementBalanceCents: -1300,
      tickedTransactionIds: [ticked.id], // forgotten is left unticked on purpose
      userId,
    });
    assert.equal(result.outcome, "difference");
    if (result.outcome !== "difference") return;
    assert.deepEqual(result.suggestion, { transactionId: forgotten.id, kind: "unticked" });
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace]);
  });

  it("resolves a real leftover difference with an adjustment transaction, completing the reconciliation", async () => {
    const workspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspace]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspace],
    );
    const acct = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspace],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 1) RETURNING id",
      [workspace, group.rows[0]!.id],
    );
    const cat = category.rows[0]!.id;

    const cleared = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-08-01",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -1000 }],
    });

    const result = await reconcileAccount(pool, workspace, {
      accountId: acct,
      date: "2026-08-31",
      statementBalanceCents: -1250, // a forgotten fee, unaccounted for anywhere
      tickedTransactionIds: [cleared.id],
      userId,
      adjustment: { categoryId: null },
    });
    assert.equal(result.outcome, "reconciled");
    if (result.outcome !== "reconciled") return;
    assert.equal(result.reconciliation.statementBalanceCents, -1250);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace]);
  });

  it("rejects a ticked id that is not an eligible cleared transaction of this account", async () => {
    const pending = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-09-01",
      status: "pending",
      splits: [{ categoryId, amountCents: -100 }],
    });

    await assert.rejects(
      () =>
        reconcileAccount(pool, workspaceId, {
          accountId,
          date: "2026-09-30",
          statementBalanceCents: -100,
          tickedTransactionIds: [pending.id],
          userId,
        }),
      (error: unknown) => isValidationError(error, "unknown_transaction"),
    );
  });

  it("unlocks a reconciled transaction, breaking the reconciliation it belonged to", async () => {
    const workspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspace]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspace],
    );
    const acct = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspace],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 1) RETURNING id",
      [workspace, group.rows[0]!.id],
    );
    const cat = category.rows[0]!.id;

    const transaction = await createTransaction(pool, {
      workspaceId: workspace,
      accountId: acct,
      occurredAt: "2026-10-01",
      status: "cleared",
      splits: [{ categoryId: cat, amountCents: -1000 }],
    });
    await reconcileAccount(pool, workspace, {
      accountId: acct,
      date: "2026-10-31",
      statementBalanceCents: -1000,
      tickedTransactionIds: [transaction.id],
      userId,
    });

    const unlocked = await unlockReconciledTransaction(pool, workspace, transaction.id, userId);
    assert.notEqual(unlocked, "not_found");
    assert.notEqual(unlocked, "not_reconciled");
    if (typeof unlocked === "string") return;
    assert.equal(unlocked.status, "cleared");

    const { rows } = await pool.query<{ broken_at: Date | null }>(
      "SELECT broken_at FROM reconciliations WHERE workspace_id = $1 AND account_id = $2",
      [workspace, acct],
    );
    assert.ok(rows[0]?.broken_at);

    const { rows: auditRows } = await pool.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE workspace_id = $1 AND action = 'reconciliation.unlock'",
      [workspace],
    );
    assert.equal(auditRows.length, 1);

    // A broken reconciliation is no longer the account's "last" one for a future attempt.
    const candidates = await getReconciliationCandidates(pool, workspace, acct, "2026-11-30");
    assert.equal(candidates.lastReconciledBalanceCents, 0);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace]);
  });

  it("reports not_found and not_reconciled for an unlock that cannot apply", async () => {
    const pending = await createTransaction(pool, {
      workspaceId,
      accountId,
      occurredAt: "2026-12-01",
      status: "pending",
      splits: [{ categoryId, amountCents: -100 }],
    });
    assert.equal(await unlockReconciledTransaction(pool, workspaceId, randomUUID(), userId), "not_found");
    assert.equal(await unlockReconciledTransaction(pool, workspaceId, pending.id, userId), "not_reconciled");
  });
});
