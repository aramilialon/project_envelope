import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { listTransactionsForAccount } from "../transactions/repository.ts";
import {
  createScheduledTransaction,
  deleteScheduledTransaction,
  fireDueScheduledTransactions,
  listReservationsForMonth,
  listScheduledTransactions,
  recordScheduledTransaction,
  skipScheduledTransaction,
  updateScheduledTransaction,
} from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("scheduled transactions repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let accountId: string;
  let creditCardAccountId: string;
  let paymentCategoryId: string;
  let categoryId: string;
  let otherCategoryId: string;

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
    const creditCardAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Card', 'credit_card', 'EUR', true) RETURNING id",
      [workspaceId],
    );
    creditCardAccountId = creditCardAccount.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
    const otherCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 2) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    otherCategoryId = otherCategory.rows[0]!.id;
    const paymentCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Card payment', 3) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    paymentCategoryId = paymentCategory.rows[0]!.id;
    await pool.query("UPDATE accounts SET payment_category_id = $1 WHERE id = $2", [paymentCategoryId, creditCardAccountId]);
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("creates a scheduled transaction with a single category", async () => {
    const scheduled = await createScheduledTransaction(pool, {
      workspaceId,
      accountId,
      nextDueDate: "2026-10-01",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId, amountCents: 90_000 }],
    });
    assert.equal(scheduled.accountId, accountId);
    assert.equal(scheduled.nextDueDate, "2026-10-01");
    assert.equal(scheduled.recurEvery, 1);
    assert.equal(scheduled.recurUnit, "month");
    assert.deepEqual(scheduled.splits.map((s) => [s.categoryId, s.amountCents]), [[categoryId, 90_000]]);
  });

  it("creates a scheduled transaction with a split template across several categories", async () => {
    const scheduled = await createScheduledTransaction(pool, {
      workspaceId,
      accountId,
      payee: "Landlord",
      nextDueDate: "2026-11-05",
      recurEvery: 1,
      recurUnit: "month",
      splits: [
        { categoryId, amountCents: 70_000 },
        { categoryId: otherCategoryId, amountCents: 10_000 },
      ],
      amountCents: 80_000,
    });
    assert.equal(scheduled.payee, "Landlord");
    assert.equal(scheduled.splits.length, 2);
  });

  it("lists every scheduled transaction of the workspace, ordered by due date", async () => {
    const list = await listScheduledTransactions(pool, workspaceId);
    assert.ok(list.length >= 2);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1]!.nextDueDate <= list[i]!.nextDueDate);
    }
  });

  it("updates payee, due date and splits, keeping what is not given", async () => {
    const created = await createScheduledTransaction(pool, {
      workspaceId,
      accountId,
      nextDueDate: "2026-09-15",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId, amountCents: 5_000 }],
    });

    const updated = await updateScheduledTransaction(pool, workspaceId, created.id, { nextDueDate: "2026-09-20" });
    assert.equal(updated?.nextDueDate, "2026-09-20");
    assert.equal(updated?.splits[0]?.amountCents, 5_000); // unchanged

    const resplit = await updateScheduledTransaction(pool, workspaceId, created.id, {
      splits: [{ categoryId: otherCategoryId, amountCents: 6_000 }],
    });
    assert.deepEqual(resplit?.splits.map((s) => [s.categoryId, s.amountCents]), [[otherCategoryId, 6_000]]);
  });

  it("updating an unknown scheduled transaction reports undefined", async () => {
    assert.equal(await updateScheduledTransaction(pool, workspaceId, randomUUID(), { nextDueDate: "2026-09-20" }), undefined);
  });

  it("deletes a scheduled transaction, and reports false on a repeat", async () => {
    const created = await createScheduledTransaction(pool, {
      workspaceId,
      accountId,
      nextDueDate: "2026-12-01",
      recurEvery: 1,
      recurUnit: "year",
      splits: [{ categoryId, amountCents: 1_000 }],
    });
    assert.equal(await deleteScheduledTransaction(pool, workspaceId, created.id), true);
    assert.equal(await deleteScheduledTransaction(pool, workspaceId, created.id), false);
  });

  it("rejects a non-positive amount", async () => {
    await assert.rejects(
      () =>
        createScheduledTransaction(pool, {
          workspaceId,
          accountId,
          nextDueDate: "2026-10-01",
          recurEvery: 1,
          recurUnit: "month",
          splits: [{ categoryId, amountCents: 0 }],
        }),
      (error: unknown) => isValidationError(error, "invalid_amount"),
    );
  });

  it("rejects a payment category", async () => {
    await assert.rejects(
      () =>
        createScheduledTransaction(pool, {
          workspaceId,
          accountId,
          nextDueDate: "2026-10-01",
          recurEvery: 1,
          recurUnit: "month",
          splits: [{ categoryId: paymentCategoryId, amountCents: 1_000 }],
        }),
      (error: unknown) => isValidationError(error, "unsupported_transaction"),
    );
  });

  it("rejects an invalid recurrence", async () => {
    await assert.rejects(
      () =>
        createScheduledTransaction(pool, {
          workspaceId,
          accountId,
          nextDueDate: "2026-10-01",
          recurEvery: 0,
          recurUnit: "month",
          splits: [{ categoryId, amountCents: 1_000 }],
        }),
      (error: unknown) => isValidationError(error, "invalid_recurrence"),
    );
  });

  it("rejects splits that do not add up to the given amountCents", async () => {
    await assert.rejects(
      () =>
        createScheduledTransaction(pool, {
          workspaceId,
          accountId,
          nextDueDate: "2026-10-01",
          recurEvery: 1,
          recurUnit: "month",
          splits: [{ categoryId, amountCents: 1_000 }],
          amountCents: 2_000,
        }),
      (error: unknown) => isValidationError(error, "split_mismatch"),
    );
  });

  it("lists reservations for a given month, across several scheduled transactions", async () => {
    const workspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Reservations', 'EUR', 'UTC')", [
      workspace,
    ]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspace],
    );
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspace],
    );
    const rent = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 1) RETURNING id",
      [workspace, group.rows[0]!.id],
    );
    const internet = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Internet', 2) RETURNING id",
      [workspace, group.rows[0]!.id],
    );

    await createScheduledTransaction(pool, {
      workspaceId: workspace,
      accountId: account.rows[0]!.id,
      nextDueDate: "2026-09-05",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId: rent.rows[0]!.id, amountCents: 90_000 }],
    });
    await createScheduledTransaction(pool, {
      workspaceId: workspace,
      accountId: account.rows[0]!.id,
      nextDueDate: "2026-09-20",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId: internet.rows[0]!.id, amountCents: 3_000 }],
    });
    // A different month: must not be reserved for September.
    await createScheduledTransaction(pool, {
      workspaceId: workspace,
      accountId: account.rows[0]!.id,
      nextDueDate: "2026-10-05",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId: rent.rows[0]!.id, amountCents: 90_000 }],
    });

    const september = await listReservationsForMonth(pool, workspace, "2026-09");
    assert.deepEqual(
      september.map((i) => [i.categoryId, i.amount]).sort(),
      [
        [internet.rows[0]!.id, 3_000],
        [rent.rows[0]!.id, 90_000],
      ].sort(),
    );

    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace]);
  });

  it("records a scheduled transaction: a real transaction dated on its own due date, split amounts negated, and nextDueDate advances", async () => {
    const created = await createScheduledTransaction(pool, {
      workspaceId,
      accountId,
      payee: "Landlord",
      memo: "Rent",
      nextDueDate: "2026-09-01",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId, amountCents: 90_000 }],
    });

    const result = await recordScheduledTransaction(pool, workspaceId, created.id);
    assert.equal(result?.transaction.accountId, accountId);
    assert.equal(result?.transaction.occurredAt.slice(0, 10), "2026-09-01");
    assert.equal(result?.transaction.payee, "Landlord");
    assert.equal(result?.transaction.memo, "Rent");
    assert.deepEqual(result?.transaction.splits.map((s) => [s.categoryId, s.amountCents]), [[categoryId, -90_000]]);
    assert.equal(result?.scheduledTransaction.nextDueDate, "2026-10-01");
  });

  it("recording an unknown scheduled transaction reports undefined", async () => {
    assert.equal(await recordScheduledTransaction(pool, workspaceId, randomUUID()), undefined);
  });

  it("skips a scheduled transaction: nextDueDate advances, no transaction is created", async () => {
    const created = await createScheduledTransaction(pool, {
      workspaceId,
      accountId,
      nextDueDate: "2026-09-10",
      recurEvery: 2,
      recurUnit: "month",
      splits: [{ categoryId, amountCents: 3_000 }],
    });

    const skipped = await skipScheduledTransaction(pool, workspaceId, created.id);
    assert.equal(skipped?.nextDueDate, "2026-11-10");
  });

  it("skipping an unknown scheduled transaction reports undefined", async () => {
    assert.equal(await skipScheduledTransaction(pool, workspaceId, randomUUID()), undefined);
  });

  describe("fireDueScheduledTransactions (#38)", () => {
    it("records every scheduled transaction due on or before today, and leaves a future one alone", async () => {
      const due = await createScheduledTransaction(pool, {
        workspaceId,
        accountId,
        payee: "Due",
        nextDueDate: "2026-09-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 1_000 }],
      });
      const future = await createScheduledTransaction(pool, {
        workspaceId,
        accountId,
        payee: "Future",
        nextDueDate: "2026-12-25",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 2_000 }],
      });

      const results = await fireDueScheduledTransactions(pool, workspaceId, "2026-09-15");
      assert.ok(results.some((r) => r.scheduledTransaction.id === due.id));
      assert.ok(!results.some((r) => r.scheduledTransaction.id === future.id));

      const recorded = await listScheduledTransactions(pool, workspaceId);
      assert.equal(recorded.find((t) => t.id === due.id)?.nextDueDate, "2026-10-01");
      assert.equal(recorded.find((t) => t.id === future.id)?.nextDueDate, "2026-12-25");
    });

    it("catches up a scheduled transaction overdue by several recurrences, not just the most recent", async () => {
      const created = await createScheduledTransaction(pool, {
        workspaceId,
        accountId,
        payee: "Weekly thing",
        nextDueDate: "2026-09-01",
        recurEvery: 7,
        recurUnit: "day",
        splits: [{ categoryId, amountCents: 500 }],
      });

      // Three weeks overdue by "2026-09-22": 09-01, 09-08, 09-15 all fire, 09-22 does not yet.
      const results = await fireDueScheduledTransactions(pool, workspaceId, "2026-09-21");
      const own = results.filter((r) => r.scheduledTransaction.id === created.id);
      assert.equal(own.length, 3);
      assert.deepEqual(
        own.map((r) => r.transaction.occurredAt.slice(0, 10)),
        ["2026-09-01", "2026-09-08", "2026-09-15"],
      );

      const recorded = await listScheduledTransactions(pool, workspaceId);
      assert.equal(recorded.find((t) => t.id === created.id)?.nextDueDate, "2026-09-22");
    });

    it("creates a real, cleared-eligible transaction for each one it fires", async () => {
      const created = await createScheduledTransaction(pool, {
        workspaceId,
        accountId,
        payee: "Streaming",
        nextDueDate: "2026-08-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 1_500 }],
      });

      await fireDueScheduledTransactions(pool, workspaceId, "2026-08-01");

      const transactions = await listTransactionsForAccount(pool, workspaceId, accountId);
      const fired = transactions.find((t) => t.payee === "Streaming" && t.budgetDate === "2026-08-01");
      assert.ok(fired, "expected a real transaction dated on the scheduled transaction's own due date");
      assert.equal(fired?.status, "pending");
      assert.deepEqual(fired?.splits.map((s) => [s.categoryId, s.amountCents]), [[categoryId, -1_500]]);

      await deleteScheduledTransaction(pool, workspaceId, created.id);
    });
  });
});
