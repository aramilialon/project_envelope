import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { closeAccount } from "../accounts/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbClient, type DbPool } from "../db/pool.ts";
import { confirmStagedTransactions } from "../import/repository.ts";
import { createTransaction, createTransfer, deleteTransaction, getTransaction, updateTransaction } from "../transactions/repository.ts";
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

  describe("an edit, a delete or an import racing a reconciliation (#554)", () => {
    type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

    function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
      return promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    }

    async function pidOf(client: DbClient): Promise<number> {
      return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    }

    /** Waits until session `waiterPid` waits on a lock held by `holderPid`; fails if `outcome` settles first. */
    async function waitUntilBlocked(waiterPid: number, holderPid: number, outcome: Promise<Outcome<unknown>>): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await pool.query<{ blocked: boolean }>(
          "SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1",
          [waiterPid, holderPid],
        );
        if (rows[0]?.blocked === true) return;
        const settled = await Promise.race([outcome, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20))]);
        if (settled !== undefined) {
          assert.fail(`the second session finished without waiting for the first one: ${JSON.stringify(settled.ok ? settled.value : String(settled.error))}`);
        }
        assert.ok(Date.now() < deadline, "the second session never waited on a lock held by the first one");
      }
    }

    /**
     * Runs `holder` in a database transaction it keeps open, then `waiter` in a second session, which
     * must wait on the first one's lock; commits the first, then the second (rolled back if it threw).
     */
    async function race<H, W>(holder: (db: DbClient) => Promise<H>, waiter: (db: DbClient) => Promise<W>): Promise<{ held: H; waited: Outcome<W> }> {
      const first = await pool.connect();
      const second = await pool.connect();
      let firstOpen = false;
      let secondOpen = false;
      try {
        // A safety net, never reached when the test passes: a session that waits this long fails instead of hanging the run.
        await first.query("SET lock_timeout = '30s'");
        await second.query("SET lock_timeout = '30s'");
        const firstPid = await pidOf(first);
        const secondPid = await pidOf(second);
        await first.query("BEGIN");
        firstOpen = true;
        const held = await holder(first);
        await second.query("BEGIN");
        secondOpen = true;
        const outcome = settle(waiter(second));
        await waitUntilBlocked(secondPid, firstPid, outcome);
        await first.query("COMMIT");
        firstOpen = false;
        const waited = await outcome;
        await second.query(waited.ok ? "COMMIT" : "ROLLBACK");
        secondOpen = false;
        return { held, waited };
      } finally {
        if (firstOpen) await first.query("ROLLBACK").catch(() => {});
        if (secondOpen) await second.query("ROLLBACK").catch(() => {});
        first.release();
        second.release();
      }
    }

    async function newAccount(name = "Racing"): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, $2, 'checking', 'EUR') RETURNING id",
        [workspaceId, name],
      );
      return rows[0]!.id;
    }

    async function clearedTransaction(acct: string, occurredAt: string, amountCents: number): Promise<string> {
      const transaction = await createTransaction(pool, {
        workspaceId,
        accountId: acct,
        occurredAt,
        status: "cleared",
        splits: [{ categoryId, amountCents }],
      });
      return transaction.id;
    }

    function reconcile(db: DbClient, acct: string, ticked: readonly string[], statementBalanceCents: number) {
      return reconcileAccount(db, workspaceId, { accountId: acct, date: "2026-03-31", statementBalanceCents, tickedTransactionIds: ticked, userId });
    }

    async function reconciliationCount(acct: string): Promise<number> {
      const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM reconciliations WHERE account_id = $1", [acct]);
      return rows[0]!.count;
    }

    function assertUnknownTransaction(outcome: Outcome<unknown>, transactionId: string): void {
      assert.ok(!outcome.ok, `expected unknown_transaction, got ${JSON.stringify(outcome.ok ? outcome.value : undefined)}`);
      assert.ok(isValidationError(outcome.error), `expected a ValidationError, got ${String(outcome.error)}`);
      assert.equal(outcome.error.code, "unknown_transaction");
      assert.deepEqual(outcome.error.details, { transactionId });
    }

    it("an edit of the date and amount waits for a reconciliation holding the row, then is refused as reconciled", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const { held, waited } = await race(
        (db) => reconcile(db, acct, [id], -1000),
        (db) => updateTransaction(db, workspaceId, id, { amountCents: -2500, occurredAt: "2026-04-02" }),
      );
      assert.equal(held.outcome, "reconciled");
      assert.deepEqual(waited, { ok: true, value: "reconciled" });
      const after = await getTransaction(pool, workspaceId, id);
      assert.equal(after?.status, "reconciled");
      assert.equal(after?.budgetDate, "2026-03-05");
      assert.equal(after?.splits[0]?.amountCents, -1000);
      const { rows } = await pool.query<{ reconciliation_id: string | null }>("SELECT reconciliation_id FROM transactions WHERE id = $1", [id]);
      assert.equal(rows[0]?.reconciliation_id, held.outcome === "reconciled" ? held.reconciliation.id : undefined);
    });

    it("a reconciliation waits for an edit moving the date past the statement date, then refuses the row", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const { held, waited } = await race(
        (db) => updateTransaction(db, workspaceId, id, { occurredAt: "2026-04-02" }),
        (db) => reconcile(db, acct, [id], -1000),
      );
      assert.ok(typeof held !== "string", `expected a record, got "${String(held)}"`);
      assertUnknownTransaction(waited, id);
      const after = await getTransaction(pool, workspaceId, id);
      assert.equal(after?.status, "cleared");
      assert.equal(after?.budgetDate, "2026-04-02");
      assert.equal(await reconciliationCount(acct), 0);
    });

    it("a reconciliation waits for an edit of the amount, then counts the new amount", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const { waited } = await race(
        (db) => updateTransaction(db, workspaceId, id, { amountCents: -2500 }),
        (db) => reconcile(db, acct, [id], -1000),
      );
      assert.deepEqual(waited, { ok: true, value: { outcome: "difference", differenceCents: 1500 } });
      assert.equal((await getTransaction(pool, workspaceId, id))?.status, "cleared");
      assert.equal(await reconciliationCount(acct), 0);
    });

    it("a delete waits for a reconciliation holding the row, then is refused as reconciled", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const { held, waited } = await race(
        (db) => reconcile(db, acct, [id], -1000),
        (db) => deleteTransaction(db, workspaceId, id, userId),
      );
      assert.equal(held.outcome, "reconciled");
      assert.deepEqual(waited, { ok: true, value: "reconciled" });
      assert.equal((await getTransaction(pool, workspaceId, id))?.status, "reconciled");
    });

    it("a reconciliation waits for a delete of a ticked row, then refuses it", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const { held, waited } = await race(
        (db) => deleteTransaction(db, workspaceId, id, userId),
        (db) => reconcile(db, acct, [id], -1000),
      );
      assert.equal(held, "deleted");
      assertUnknownTransaction(waited, id);
      assert.equal(await reconciliationCount(acct), 0);
    });

    it("an edit of a transfer's other leg waits for a reconciliation of this leg, then is refused as reconciled", async () => {
      const acct = await newAccount();
      const savings = await newAccount("Racing savings");
      const transfer = await createTransfer(pool, {
        workspaceId,
        sourceAccountId: acct,
        destinationAccountId: savings,
        occurredAt: "2026-03-05",
        amountCents: 5000,
      });
      await updateTransaction(pool, workspaceId, transfer.source.id, { status: "cleared" });
      const { waited } = await race(
        (db) => reconcile(db, acct, [transfer.source.id], -5000),
        (db) => updateTransaction(db, workspaceId, transfer.destination.id, { amountCents: 7000 }),
      );
      assert.deepEqual(waited, { ok: true, value: "reconciled" });
      assert.equal((await getTransaction(pool, workspaceId, transfer.source.id))?.splits[0]?.amountCents, -5000);
      assert.equal((await getTransaction(pool, workspaceId, transfer.destination.id))?.splits[0]?.amountCents, 5000);
    });

    it("an import clearing a duplicate waits for a reconciliation holding the row, and leaves it reconciled", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO staged_transactions (workspace_id, account_id, occurred_at, amount_cents, duplicate_of) VALUES ($1, $2, '2026-03-05', -1000, $3) RETURNING id",
        [workspaceId, acct, id],
      );
      const stagedId = rows[0]!.id;
      const { waited } = await race(
        (db) => reconcile(db, acct, [id], -1000),
        (db) => confirmStagedTransactions(db, workspaceId, acct, [{ stagedTransactionId: stagedId, kind: "income" }]),
      );
      assert.deepEqual(waited, { ok: true, value: [{ stagedTransactionId: stagedId, outcome: "duplicate_cleared", transactionId: id }] });
      assert.equal((await getTransaction(pool, workspaceId, id))?.status, "reconciled");
    });

    it("an edit, a close of the account and a reconciliation of the same row all finish, without a deadlock", async () => {
      const acct = await newAccount();
      const id = await clearedTransaction(acct, "2026-03-05", -1000);
      const editor = await pool.connect();
      const closer = await pool.connect();
      const reconciler = await pool.connect();
      const open = new Set<DbClient>();
      try {
        for (const client of [editor, closer, reconciler]) {
          await client.query("SET lock_timeout = '30s'");
        }
        const editorPid = await pidOf(editor);
        const closerPid = await pidOf(closer);
        const reconcilerPid = await pidOf(reconciler);

        // The editor holds the row (FOR UPDATE) and the account (FOR KEY SHARE) until it commits.
        await editor.query("BEGIN");
        open.add(editor);
        const edited = await updateTransaction(editor, workspaceId, id, { memo: "edited" });
        assert.ok(typeof edited !== "string", `expected a record, got "${String(edited)}"`);

        // The close waits for the account; the reconciliation waits for the row.
        await closer.query("BEGIN");
        open.add(closer);
        const closing = settle(closeAccount(closer, workspaceId, acct));
        await waitUntilBlocked(closerPid, editorPid, closing);
        await reconciler.query("BEGIN");
        open.add(reconciler);
        const reconciling = settle(reconcile(reconciler, acct, [id], -1000));
        await waitUntilBlocked(reconcilerPid, editorPid, reconciling);

        await editor.query("COMMIT");
        open.delete(editor);
        // Whichever of the two gets the account first finishes first; the other then waits for it to commit.
        const pending = new Map<DbClient, Promise<Outcome<unknown>>>([
          [closer, closing],
          [reconciler, reconciling],
        ]);
        while (pending.size > 0) {
          const [client, outcome] = await Promise.race([...pending].map(([c, p]) => p.then((o) => [c, o] as const)));
          if (!outcome.ok) throw outcome.error;
          await client.query("COMMIT");
          open.delete(client);
          pending.delete(client);
        }
        const closed = await closing;
        assert.ok(closed.ok);
        assert.equal(closed.value.status, "not_empty");
        const reconciled = await reconciling;
        assert.ok(reconciled.ok);
        assert.equal(reconciled.value.outcome, "reconciled");
      } finally {
        for (const client of open) await client.query("ROLLBACK").catch(() => {});
        editor.release();
        closer.release();
        reconciler.release();
      }
      const after = await getTransaction(pool, workspaceId, id);
      assert.equal(after?.status, "reconciled");
      assert.equal(after?.memo, "edited");
    });
  });
});
