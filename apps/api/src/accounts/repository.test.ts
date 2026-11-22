import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbClient, type DbPool } from "../db/pool.ts";
import { createTransaction, listTransactionsForAccount } from "../transactions/repository.ts";
import { closeAccount, createAccount, isBrokerageOffBudgetViolation, listAccounts } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("accounts repository", () => {
  let pool: DbPool;
  let workspaceId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'Europe/Rome')", [
      workspaceId,
    ]);
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("creates a plain account with no payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Checking",
      type: "checking",
      currency: "EUR",
      onBudget: true,
    });
    assert.equal(account.name, "Checking");
    assert.equal(account.onBudget, true);
    assert.equal(account.paymentCategoryId, null);
    assert.equal(account.closedAt, null);
  });

  it("creating an on-budget credit card also creates and links its payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Visa",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
    });
    assert.ok(account.paymentCategoryId, "expected a payment category to be created and linked");

    const category = await pool.query<{ name: string; group_id: string }>(
      "SELECT name, group_id FROM categories WHERE id = $1",
      [account.paymentCategoryId],
    );
    assert.equal(category.rows[0]?.name, "Visa payment");

    const group = await pool.query<{ name: string }>("SELECT name FROM category_groups WHERE id = $1", [
      category.rows[0]?.group_id,
    ]);
    assert.equal(group.rows[0]?.name, "Credit card payments");
  });

  it("reuses the same payment category group across credit cards", async () => {
    const visa = await createAccount(pool, { workspaceId, name: "Visa 2", type: "credit_card", currency: "EUR", onBudget: true });
    const amex = await createAccount(pool, { workspaceId, name: "Amex", type: "credit_card", currency: "EUR", onBudget: true });

    const groups = await pool.query<{ group_id: string }>("SELECT group_id FROM categories WHERE id = ANY($1)", [
      [visa.paymentCategoryId, amex.paymentCategoryId],
    ]);
    assert.equal(groups.rows[0]?.group_id, groups.rows[1]?.group_id);
  });

  it("an off-budget credit card gets no payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Off-budget card",
      type: "credit_card",
      currency: "EUR",
      onBudget: false,
    });
    assert.equal(account.paymentCategoryId, null);
  });

  it("a starting balance creates a transaction categorized to the payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Amex with debt",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
      startingBalanceCents: -120000,
    });

    const rows = await pool.query<{ payee: string; status: string; category_id: string; amount_cents: string }>(
      `SELECT t.payee, t.status, s.category_id, s.amount_cents
       FROM transactions t JOIN splits s ON s.transaction_id = t.id
       WHERE t.account_id = $1`,
      [account.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.payee, "Starting balance");
    assert.equal(rows.rows[0]?.status, "cleared");
    assert.equal(rows.rows[0]?.category_id, account.paymentCategoryId);
    assert.equal(Number(rows.rows[0]?.amount_cents), -120000);
  });

  it("a starting balance is dated at midnight of today in the workspace's time zone and comes before a purchase of the same day (#706)", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Card owing 500",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
      startingBalanceCents: -50_000,
    });
    const { rows: start } = await pool.query<{ day: string; today: string; at_midnight: boolean }>(
      `SELECT to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS day,
              to_char(now() AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS today,
              (t.occurred_at AT TIME ZONE w.time_zone)::time = '00:00' AS at_midnight
       FROM transactions t JOIN workspaces w ON w.id = t.workspace_id WHERE t.account_id = $1`,
      [account.id],
    );
    assert.equal(start[0]?.day, start[0]?.today, "dated today in the workspace's time zone");
    assert.equal(start[0]?.at_midnight, true);

    const { rows: group } = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Everyday', 1) RETURNING id",
      [workspaceId],
    );
    const { rows: groceries } = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group[0]!.id],
    );
    const categoryId = groceries[0]!.id;
    await createTransaction(pool, {
      workspaceId,
      accountId: account.id,
      occurredAt: start[0]!.day,
      payee: "Grocer",
      splits: [{ categoryId, amountCents: -4_567 }],
    });

    let balance = 0;
    const register = (await listTransactionsForAccount(pool, workspaceId, account.id)).map((t) => {
      balance += t.splits.reduce((sum, s) => sum + s.amountCents, 0);
      return [t.payee, t.budgetDate, balance];
    });
    assert.deepEqual(register, [
      ["Starting balance", start[0]!.day, -50_000],
      ["Grocer", start[0]!.day, -54_567],
    ]);
  });

  it("a zero starting balance creates no transaction", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Fresh card",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
      startingBalanceCents: 0,
    });
    const { rows } = await pool.query("SELECT 1 FROM transactions WHERE account_id = $1", [account.id]);
    assert.equal(rows.length, 0);
  });

  it("lists every account of a workspace", async () => {
    const otherWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'Europe/Rome')", [
      otherWorkspaceId,
    ]);
    await createAccount(pool, { workspaceId: otherWorkspaceId, name: "Not mine", type: "cash", currency: "EUR", onBudget: true });

    const accounts = await listAccounts(pool, workspaceId);
    assert.ok(accounts.length > 0);
    assert.ok(accounts.every((a) => a.workspaceId === workspaceId));

    await pool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspaceId]);
  });

  it("closes an account once; closing it again is a no-op that finds nothing", async () => {
    const account = await createAccount(pool, { workspaceId, name: "To close", type: "cash", currency: "EUR", onBudget: true });

    const client = await pool.connect();
    try {
      const closed = await closeAccount(client, workspaceId, account.id);
      assert.equal(closed.status, "closed");
      assert.ok(closed.status === "closed" && closed.account.closedAt);

      const again = await closeAccount(client, workspaceId, account.id);
      assert.deepEqual(again, { status: "not_found" });
    } finally {
      client.release();
    }
  });

  it("refuses to close an account with a balance, closing nothing (#703)", async () => {
    const account = await createAccount(pool, { workspaceId, name: "Not empty", type: "credit_card", currency: "EUR", onBudget: true, startingBalanceCents: -12_345 });

    const client = await pool.connect();
    try {
      const refused = await closeAccount(client, workspaceId, account.id);
      assert.deepEqual(refused, { status: "not_empty", balanceCents: -12_345, laterRows: { count: 0, firstDate: null }, holdsPositions: false, scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null } });
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ closed_at: Date | null }>("SELECT closed_at FROM accounts WHERE id = $1", [account.id]);
    assert.equal(rows[0]?.closed_at, null);
  });

  it("waits for a transaction being added to the account, then refuses with its amount (#703)", async () => {
    const account = await createAccount(pool, { workspaceId, name: "Racing", type: "checking", currency: "EUR", onBudget: true });
    const writer = await pool.connect();
    const closer = await pool.connect();
    try {
      // The writer adds a transaction and holds it uncommitted: its foreign key holds a key-share lock on the account row.
      await writer.query("BEGIN");
      const { rows } = await writer.query<{ id: string }>(
        "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending') RETURNING id",
        [workspaceId, account.id],
      );
      await writer.query("INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, NULL, 4200)", [
        workspaceId,
        rows[0]!.id,
      ]);

      const { rows: pidRows } = await closer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const closerPid = pidRows[0]!.pid;
      await closer.query("BEGIN");
      const closing = closeAccount(closer, workspaceId, account.id);

      // The closer must be waiting on a lock (its FOR UPDATE), not have read the account as empty.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows: waiting } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [closerPid]);
        if (waiting.length > 0) break;
        assert.ok(Date.now() < deadline, "closeAccount never waited for the uncommitted transaction's lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await writer.query("COMMIT");
      assert.deepEqual(await closing, { status: "not_empty", balanceCents: 4200, laterRows: { count: 0, firstDate: null }, holdsPositions: false, scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null } });
      await closer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      await closer.query("ROLLBACK").catch(() => {});
      writer.release();
      closer.release();
    }
    const { rows } = await pool.query<{ closed_at: Date | null }>("SELECT closed_at FROM accounts WHERE id = $1", [account.id]);
    assert.equal(rows[0]?.closed_at, null);
  });

  describe("a closed account takes no writes (#729, migration 0033)", () => {
    /** Whether `promise` was refused by migration 0033's trigger. */
    async function assertAccountClosed(promise: Promise<unknown>): Promise<void> {
      await assert.rejects(promise, (error: unknown) => {
        const { code, constraint } = error as { code?: unknown; constraint?: unknown };
        return code === "23514" && constraint === "account_closed";
      });
    }

    async function insertTransaction(db: DbPool | DbClient, accountId: string, amountCents: number): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending') RETURNING id",
        [workspaceId, accountId],
      );
      await db.query("INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, NULL, $3)", [
        workspaceId,
        rows[0]!.id,
        amountCents,
      ]);
      return rows[0]!.id;
    }

    it("makes a write to an account being closed wait, then refuses it once the close commits", async () => {
      const account = await createAccount(pool, { workspaceId, name: "Closing first", type: "checking", currency: "EUR", onBudget: true });
      const closer = await pool.connect();
      const writer = await pool.connect();
      try {
        await closer.query("BEGIN");
        assert.equal((await closeAccount(closer, workspaceId, account.id)).status, "closed");

        const { rows: pidRows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const writerPid = pidRows[0]!.pid;
        await writer.query("BEGIN");
        const writing = writer.query(
          "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending')",
          [workspaceId, account.id],
        );
        // Kept from an unhandled rejection while the loop below waits; asserted after the commit.
        writing.catch(() => {});

        // The writer must be waiting on the close's row lock, not have read the account as open.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows: waiting } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [writerPid]);
          if (waiting.length > 0) break;
          assert.ok(Date.now() < deadline, "the write never waited for the close's lock");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await closer.query("COMMIT");
        await assertAccountClosed(writing);
      } finally {
        await writer.query("ROLLBACK").catch(() => {});
        await closer.query("ROLLBACK").catch(() => {});
        writer.release();
        closer.release();
      }
      const { rows } = await pool.query("SELECT 1 FROM transactions WHERE account_id = $1", [account.id]);
      assert.equal(rows.length, 0);
    });

    it("makes a close wait for a write that takes no foreign key lock on the account, an update of a split, then refuses with its amount", async () => {
      // A split's foreign key points at its transaction, not the account: only the trigger's
      // FOR KEY SHARE on the account makes the close wait for this write.
      const account = await createAccount(pool, { workspaceId, name: "Split first", type: "checking", currency: "EUR", onBudget: true });
      const transactionId = await insertTransaction(pool, account.id, 0);
      const writer = await pool.connect();
      const closer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("UPDATE splits SET amount_cents = 4200 WHERE transaction_id = $1", [transactionId]);

        const { rows: pidRows } = await closer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const closerPid = pidRows[0]!.pid;
        await closer.query("BEGIN");
        const closing = closeAccount(closer, workspaceId, account.id);
        // Kept from an unhandled rejection while the loop below waits; asserted after the commit.
        closing.catch(() => {});

        // The close must be waiting on the split update's lock, not have read the account as empty.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows: waiting } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [closerPid]);
          if (waiting.length > 0) break;
          assert.ok(Date.now() < deadline, "closeAccount never waited for the uncommitted split update");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await writer.query("COMMIT");
        assert.deepEqual(await closing, {
          status: "not_empty",
          balanceCents: 4200,
          laterRows: { count: 0, firstDate: null },
          holdsPositions: false,
          scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null },
        });
        await closer.query("COMMIT");
      } finally {
        await writer.query("ROLLBACK").catch(() => {});
        await closer.query("ROLLBACK").catch(() => {});
        writer.release();
        closer.release();
      }
      const { rows } = await pool.query<{ closed_at: Date | null }>("SELECT closed_at FROM accounts WHERE id = $1", [account.id]);
      assert.equal(rows[0]?.closed_at, null);
    });

    it("refuses inserting, changing and deleting a closed account's transactions and splits, and moving one into it", async () => {
      const account = await createAccount(pool, { workspaceId, name: "Closed rows", type: "checking", currency: "EUR", onBudget: true });
      const open = await createAccount(pool, { workspaceId, name: "Still open", type: "checking", currency: "EUR", onBudget: true });
      const transactionId = await insertTransaction(pool, account.id, 0);
      const openTransactionId = await insertTransaction(pool, open.id, 100);
      const { rows: schedules } = await pool.query<{ id: string }>(
        "INSERT INTO scheduled_transactions (workspace_id, account_id, next_due_date, recur_every, recur_unit) VALUES ($1, $2, '2030-01-01', 1, 'month') RETURNING id",
        [workspaceId, account.id],
      );
      const scheduleId = schedules[0]!.id;
      await pool.query("INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, amount_cents) VALUES ($1, $2, 100)", [
        workspaceId,
        scheduleId,
      ]);
      // Closed directly: a schedule would refuse the close, but data from before #729 may hold one.
      await pool.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [account.id]);

      await assertAccountClosed(insertTransaction(pool, account.id, 0));
      await assertAccountClosed(pool.query("UPDATE transactions SET memo = 'later' WHERE id = $1", [transactionId]));
      await assertAccountClosed(pool.query("UPDATE splits SET amount_cents = 5 WHERE transaction_id = $1", [transactionId]));
      await assertAccountClosed(
        pool.query("INSERT INTO splits (workspace_id, transaction_id, amount_cents) VALUES ($1, $2, 5)", [workspaceId, transactionId]),
      );
      await assertAccountClosed(pool.query("DELETE FROM splits WHERE transaction_id = $1", [transactionId]));
      await assertAccountClosed(pool.query("DELETE FROM transactions WHERE id = $1", [transactionId]));
      // Out of the closed account, or into it: both sides are checked.
      await assertAccountClosed(pool.query("UPDATE transactions SET account_id = $1 WHERE id = $2", [account.id, openTransactionId]));
      await assertAccountClosed(pool.query("UPDATE transactions SET account_id = $1 WHERE id = $2", [open.id, transactionId]));
      await assertAccountClosed(
        pool.query(
          "INSERT INTO scheduled_transactions (workspace_id, account_id, next_due_date, recur_every, recur_unit) VALUES ($1, $2, '2030-01-01', 1, 'month')",
          [workspaceId, account.id],
        ),
      );
      // A scheduled transaction's splits belong to its account too.
      await assertAccountClosed(
        pool.query("INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, amount_cents) VALUES ($1, $2, 5)", [
          workspaceId,
          scheduleId,
        ]),
      );
      await assertAccountClosed(pool.query("UPDATE scheduled_transaction_splits SET amount_cents = 5 WHERE scheduled_transaction_id = $1", [scheduleId]));
      await assertAccountClosed(pool.query("DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id = $1", [scheduleId]));
      await assertAccountClosed(
        pool.query("INSERT INTO reconciliations (workspace_id, account_id, reconciled_at, statement_balance_cents) VALUES ($1, $2, '2026-01-01', 0)", [
          workspaceId,
          account.id,
        ]),
      );

      // The open account's own rows are untouched by the guard.
      await pool.query("UPDATE transactions SET memo = 'fine' WHERE id = $1", [openTransactionId]);
      const { rows } = await pool.query("SELECT 1 FROM transactions WHERE account_id = $1", [account.id]);
      assert.equal(rows.length, 1);
    });

    // Without the trigger's pg_trigger_depth() skip this fails, whichever order the cascade reaches
    // the rows in: a closed account still there is refused, and one already deleted is not found.
    it("still deletes a workspace whose closed account has transactions, transfers, splits, schedules, reconciliations and trades", async () => {
      const doomedWorkspaceId = randomUUID();
      await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Doomed', 'EUR', 'Europe/Rome')", [
        doomedWorkspaceId,
      ]);
      const closed = await createAccount(pool, { workspaceId: doomedWorkspaceId, name: "Closed", type: "checking", currency: "EUR", onBudget: true });
      const open = await createAccount(pool, { workspaceId: doomedWorkspaceId, name: "Open", type: "checking", currency: "EUR", onBudget: true });
      const leg = async (accountId: string, amountCents: number, reconciliationId: string | null): Promise<string> => {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO transactions (workspace_id, account_id, occurred_at, status, reconciliation_id)
           VALUES ($1, $2, now(), $3, $4) RETURNING id`,
          [doomedWorkspaceId, accountId, reconciliationId === null ? "cleared" : "reconciled", reconciliationId],
        );
        await pool.query("INSERT INTO splits (workspace_id, transaction_id, amount_cents) VALUES ($1, $2, $3)", [
          doomedWorkspaceId,
          rows[0]!.id,
          amountCents,
        ]);
        return rows[0]!.id;
      };
      const { rows: reconciliations } = await pool.query<{ id: string }>(
        "INSERT INTO reconciliations (workspace_id, account_id, reconciled_at, statement_balance_cents) VALUES ($1, $2, '2026-01-01', 0) RETURNING id",
        [doomedWorkspaceId, closed.id],
      );
      // A brokerage account's fee, with its cash leg (ADR 0012) on the same closed account.
      const brokerage = await createAccount(pool, { workspaceId: doomedWorkspaceId, name: "Broker", type: "brokerage", currency: "EUR", onBudget: false });
      const { rows: portfolios } = await pool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Doomed') RETURNING id", [
        doomedWorkspaceId,
      ]);
      const { rows: trades } = await pool.query<{ id: string }>(
        `INSERT INTO trades (workspace_id, account_id, portfolio_id, type, trade_date, fees_cents)
         VALUES ($1, $2, $3, 'fee', '2026-01-02', 250) RETURNING id`,
        [doomedWorkspaceId, brokerage.id, portfolios[0]!.id],
      );
      const { rows: cashLegs } = await pool.query<{ id: string }>(
        "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, trade_id) VALUES ($1, $2, now(), 'cleared', $3) RETURNING id",
        [doomedWorkspaceId, brokerage.id, trades[0]!.id],
      );
      await pool.query("INSERT INTO splits (workspace_id, transaction_id, amount_cents) VALUES ($1, $2, -250)", [doomedWorkspaceId, cashLegs[0]!.id]);
      const out = await leg(closed.id, -500, reconciliations[0]!.id);
      const into = await leg(open.id, 500, null);
      await pool.query("UPDATE transactions SET transfer_id = $1 WHERE id = $2", [into, out]);
      await pool.query("UPDATE transactions SET transfer_id = $1 WHERE id = $2", [out, into]);
      const { rows: schedules } = await pool.query<{ id: string }>(
        "INSERT INTO scheduled_transactions (workspace_id, account_id, next_due_date, recur_every, recur_unit) VALUES ($1, $2, '2030-01-01', 1, 'month') RETURNING id",
        [doomedWorkspaceId, closed.id],
      );
      await pool.query("INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, amount_cents) VALUES ($1, $2, 100)", [
        doomedWorkspaceId,
        schedules[0]!.id,
      ]);
      // Closed directly: a schedule would refuse the close, but data from before #729 may hold one.
      await pool.query("UPDATE accounts SET closed_at = now() WHERE id = ANY($1)", [[closed.id, brokerage.id]]);

      await pool.query("DELETE FROM workspaces WHERE id = $1", [doomedWorkspaceId]);
      const { rows } = await pool.query("SELECT 1 FROM accounts WHERE workspace_id = $1", [doomedWorkspaceId]);
      assert.equal(rows.length, 0);
      const { rows: tradesLeft } = await pool.query("SELECT 1 FROM trades WHERE workspace_id = $1", [doomedWorkspaceId]);
      assert.equal(tradesLeft.length, 0);
    });
  });

  describe("brokerage accounts (#74)", () => {
    it("creates an off-budget brokerage account with no payment category", async () => {
      const account = await createAccount(pool, { workspaceId, name: "Broker", type: "brokerage", currency: "EUR", onBudget: false });
      assert.equal(account.type, "brokerage");
      assert.equal(account.onBudget, false);
      assert.equal(account.paymentCategoryId, null);
    });

    it("maps the database's refusal of an on-budget brokerage account to a ValidationError, writing nothing", async () => {
      await assert.rejects(
        () => createAccount(pool, { workspaceId, name: "On-budget broker", type: "brokerage", currency: "EUR", onBudget: true }),
        (error: unknown) => isValidationError(error, "brokerage_on_budget"),
      );
      const { rows } = await pool.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND name = 'On-budget broker'", [
        workspaceId,
      ]);
      assert.equal(rows.length, 0);
    });

    it("the database rejects inserting an on-budget brokerage account, recognized as that violation", async () => {
      await assert.rejects(
        () =>
          pool.query(
            "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Raw broker', 'brokerage', 'EUR', true)",
            [workspaceId],
          ),
        (error: unknown) => isBrokerageOffBudgetViolation(error),
      );
    });

    it("the database rejects updating a brokerage account to on budget", async () => {
      const account = await createAccount(pool, { workspaceId, name: "Broker 2", type: "brokerage", currency: "EUR", onBudget: false });
      await assert.rejects(
        () => pool.query("UPDATE accounts SET on_budget = true WHERE id = $1", [account.id]),
        (error: unknown) => isBrokerageOffBudgetViolation(error),
      );
    });

    it("the database rejects turning an on-budget account into a brokerage one", async () => {
      const account = await createAccount(pool, { workspaceId, name: "Was checking", type: "checking", currency: "EUR", onBudget: true });
      await assert.rejects(
        () => pool.query("UPDATE accounts SET type = 'brokerage' WHERE id = $1", [account.id]),
        (error: unknown) => isBrokerageOffBudgetViolation(error),
      );
    });

    it("does not mistake another constraint's violation for the brokerage one", async () => {
      await assert.rejects(
        () =>
          pool.query(
            "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Odd 2', 'off_budget', 'EUR', false)",
            [workspaceId],
          ),
        (error: unknown) => !isBrokerageOffBudgetViolation(error) && /accounts_type_check/.test(String(error)),
      );
    });
  });
});
