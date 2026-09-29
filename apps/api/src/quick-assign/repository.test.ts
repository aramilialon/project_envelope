import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createAssignmentBatch } from "../assignments/repository.ts";
import { createAccount } from "../accounts/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { upsertGoal } from "../goals/repository.ts";
import { createTransaction } from "../transactions/repository.ts";
import { runQuickAssign } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("quick assign repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let authorId: string;
  let checkingAccountId: string;
  let groupId: string;
  let otherGroupId: string;
  let categoryA: string;
  let categoryB: string;
  let categoryOther: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    authorId = user.rows[0]!.id;
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    checkingAccountId = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    groupId = group.rows[0]!.id;
    const otherGroup = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Other', 2) RETURNING id",
      [workspaceId],
    );
    otherGroupId = otherGroup.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'A', 1) RETURNING id",
      [workspaceId, groupId],
    );
    categoryA = a.rows[0]!.id;
    const b = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'B', 2) RETURNING id",
      [workspaceId, groupId],
    );
    categoryB = b.rows[0]!.id;
    const other = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Other', 1) RETURNING id",
      [workspaceId, otherGroupId],
    );
    categoryOther = other.rows[0]!.id;

    // Plenty of unassigned money for every scenario below.
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-01-01",
      splits: [{ categoryId: null, amountCents: 10_000_000 }],
    });
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [authorId]);
    await pool.end();
  });

  it("fund_targets: assigns exactly the missing amount, skipping a category with no goal", async () => {
    await upsertGoal(pool, workspaceId, categoryA, { kind: "monthly", amountCents: 10_000 });
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-02", sourceCategoryId: null, destinationCategoryId: categoryA, amountCents: 3_000 }],
    });

    const entries = await runQuickAssign(pool, workspaceId, authorId, "2026-02", { kind: "all" }, "fund_targets");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.destinationCategoryId, categoryA);
    assert.equal(entries[0]?.amountCents, 7_000);
  });

  it("cover_overspending: assigns exactly enough to bring a negative category to zero", async () => {
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-03", sourceCategoryId: null, destinationCategoryId: categoryB, amountCents: 1_000 }],
    });
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-03-05",
      splits: [{ categoryId: categoryB, amountCents: -6_000 }],
    });

    const entries = await runQuickAssign(pool, workspaceId, authorId, "2026-03", { kind: "all" }, "cover_overspending");
    const entry = entries.find((e) => e.destinationCategoryId === categoryB);
    assert.equal(entry?.amountCents, 5_000);
  });

  it("cover_card_debt: assigns toward uncovered, never more than needed", async () => {
    const card = await createAccount(pool, { workspaceId, name: "Card", type: "credit_card", currency: "EUR", onBudget: true });
    const paymentCategoryId = card.paymentCategoryId;
    assert.ok(paymentCategoryId, "expected an on-budget credit card to get a payment category");
    // A starting balance dated before the test month, exactly as createAccount's own
    // createStartingBalanceTransaction records one, but with a controlled date instead of now().
    await createTransaction(pool, {
      workspaceId,
      accountId: card.id,
      occurredAt: "2026-01-15",
      status: "cleared",
      splits: [{ categoryId: paymentCategoryId, amountCents: -12_000 }],
    });

    const firstRound = await runQuickAssign(pool, workspaceId, authorId, "2026-04", { kind: "all" }, "cover_card_debt");
    const firstEntry = firstRound.find((e) => e.destinationCategoryId === paymentCategoryId);
    assert.equal(firstEntry?.amountCents, 12_000);

    // Uncovered is now 0: a second round has nothing left to cover.
    const secondRound = await runQuickAssign(pool, workspaceId, authorId, "2026-04", { kind: "all" }, "cover_card_debt");
    assert.equal(secondRound.some((e) => e.destinationCategoryId === paymentCategoryId), false);
  });

  it("repeat_assigned: copies last month's assigned amount into the current month", async () => {
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-05", sourceCategoryId: null, destinationCategoryId: categoryA, amountCents: 4_000 }],
    });

    const entries = await runQuickAssign(pool, workspaceId, authorId, "2026-06", { kind: "all" }, "repeat_assigned");
    const entry = entries.find((e) => e.destinationCategoryId === categoryA);
    assert.equal(entry?.amountCents, 4_000);
  });

  it("repeat_spent: copies last month's spent amount into the current month", async () => {
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-06-10",
      splits: [{ categoryId: categoryB, amountCents: -6_000 }],
    });

    const entries = await runQuickAssign(pool, workspaceId, authorId, "2026-07", { kind: "all" }, "repeat_spent");
    const entry = entries.find((e) => e.destinationCategoryId === categoryB);
    assert.equal(entry?.amountCents, 6_000);
  });

  it("funds categories in table order until unassigned money runs out, never partially out of order", async () => {
    // A workspace of its own, with a small, controlled amount of unassigned money.
    const smallWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Small', 'EUR', 'UTC')", [
      smallWorkspaceId,
    ]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [smallWorkspaceId],
    );
    const smallAccountId = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [smallWorkspaceId],
    );
    const smallGroupId = group.rows[0]!.id;
    const ids: string[] = [];
    for (const [name, sortOrder] of [
      ["First", 1],
      ["Second", 2],
      ["Third", 3],
    ] as const) {
      const category = await pool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
        [smallWorkspaceId, smallGroupId, name, sortOrder],
      );
      ids.push(category.rows[0]!.id);
    }
    const [first, second, third] = ids as [string, string, string];

    await createTransaction(pool, {
      workspaceId: smallWorkspaceId,
      accountId: smallAccountId,
      occurredAt: "2026-01-01",
      splits: [{ categoryId: null, amountCents: 6_000 }],
    });
    await createTransaction(pool, {
      workspaceId: smallWorkspaceId,
      accountId: smallAccountId,
      occurredAt: "2026-02-01",
      splits: [{ categoryId: first, amountCents: -3_000 }],
    });
    await createTransaction(pool, {
      workspaceId: smallWorkspaceId,
      accountId: smallAccountId,
      occurredAt: "2026-02-01",
      splits: [{ categoryId: second, amountCents: -4_000 }],
    });
    await createTransaction(pool, {
      workspaceId: smallWorkspaceId,
      accountId: smallAccountId,
      occurredAt: "2026-02-01",
      splits: [{ categoryId: third, amountCents: -5_000 }],
    });

    const entries = await runQuickAssign(pool, smallWorkspaceId, authorId, "2026-02", { kind: "all" }, "cover_overspending");

    const byCategory = new Map(entries.map((e) => [e.destinationCategoryId, e.amountCents]));
    assert.equal(byCategory.get(first), 3_000); // fully funded: 6000 - 3000 = 3000 left
    assert.equal(byCategory.get(second), 3_000); // partially funded: exactly what remained
    assert.equal(byCategory.has(third), false); // nothing left at all

    await pool.query("DELETE FROM workspaces WHERE id = $1", [smallWorkspaceId]);
  });

  it("every entry of one call shares a single batch_id", async () => {
    // A workspace of its own, so neither category carries a surplus from earlier tests
    // that would swallow the small overspend below.
    const freshWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Fresh', 'EUR', 'UTC')", [
      freshWorkspaceId,
    ]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [freshWorkspaceId],
    );
    const freshAccountId = account.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [freshWorkspaceId],
    );
    const freshGroupId = group.rows[0]!.id;
    const catX = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'X', 1) RETURNING id",
      [freshWorkspaceId, freshGroupId],
    );
    const catY = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Y', 2) RETURNING id",
      [freshWorkspaceId, freshGroupId],
    );

    await createTransaction(pool, {
      workspaceId: freshWorkspaceId,
      accountId: freshAccountId,
      occurredAt: "2026-08-01",
      splits: [{ categoryId: null, amountCents: 100_000 }],
    });
    await createTransaction(pool, {
      workspaceId: freshWorkspaceId,
      accountId: freshAccountId,
      occurredAt: "2026-08-05",
      splits: [{ categoryId: catX.rows[0]!.id, amountCents: -1_000 }],
    });
    await createTransaction(pool, {
      workspaceId: freshWorkspaceId,
      accountId: freshAccountId,
      occurredAt: "2026-08-05",
      splits: [{ categoryId: catY.rows[0]!.id, amountCents: -2_000 }],
    });

    const entries = await runQuickAssign(pool, freshWorkspaceId, authorId, "2026-08", { kind: "all" }, "cover_overspending");
    assert.equal(entries.length, 2);
    const batchIds = new Set(entries.map((e) => e.batchId));
    assert.equal(batchIds.size, 1);

    await pool.query("DELETE FROM workspaces WHERE id = $1", [freshWorkspaceId]);
  });

  it("scope: a group restricts funding to that group's own categories", async () => {
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-09-05",
      splits: [{ categoryId: categoryA, amountCents: -1_000 }],
    });
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-09-05",
      splits: [{ categoryId: categoryOther, amountCents: -1_000 }],
    });

    const entries = await runQuickAssign(
      pool,
      workspaceId,
      authorId,
      "2026-09",
      { kind: "group", groupId: otherGroupId },
      "cover_overspending",
    );
    assert.ok(entries.every((e) => e.destinationCategoryId === categoryOther));
    assert.ok(entries.some((e) => e.destinationCategoryId === categoryOther));
  });

  it("returns an empty array when nothing needs funding", async () => {
    // A workspace of its own, with no goals at all: fund_targets has nothing to do.
    const emptyWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Empty', 'EUR', 'UTC')", [
      emptyWorkspaceId,
    ]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [emptyWorkspaceId],
    );
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [emptyWorkspaceId],
    );
    await pool.query("INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Plain', 1)", [
      emptyWorkspaceId,
      group.rows[0]!.id,
    ]);
    await createTransaction(pool, {
      workspaceId: emptyWorkspaceId,
      accountId: account.rows[0]!.id,
      occurredAt: "2026-10-01",
      splits: [{ categoryId: null, amountCents: 1_000 }],
    });

    const entries = await runQuickAssign(pool, emptyWorkspaceId, authorId, "2026-10", { kind: "all" }, "fund_targets");
    assert.deepEqual(entries, []);

    await pool.query("DELETE FROM workspaces WHERE id = $1", [emptyWorkspaceId]);
  });
});
