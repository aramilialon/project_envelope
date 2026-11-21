import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError, MAX_AMOUNT_CENTS } from "@envelope/core";

import { createAssignmentBatch } from "../assignments/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { deleteGoal, getGoal, getGoalProgress, listGoalProgress, upsertGoal } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("goals repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let authorId: string;
  let categoryId: string;

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
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Holidays', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [authorId]);
    await pool.end();
  });

  it("creates a monthly-amount goal", async () => {
    const goal = await upsertGoal(pool, workspaceId, categoryId, { kind: "monthly", amountCents: 60000 });
    assert.equal(goal.kind, "monthly");
    assert.equal(goal.amountCents, 60000);
    assert.equal(goal.dueMonth, null);
    assert.equal(goal.every, null);
  });

  it("refuses an amount of 0 or less, a fraction or one above the cap with invalid_goal_amount (#701)", async () => {
    for (const amountCents of [0, -100, 0.5, MAX_AMOUNT_CENTS + 1]) {
      await assert.rejects(upsertGoal(pool, workspaceId, categoryId, { kind: "balance", amountCents }), (error: unknown) => {
        assert.ok(isValidationError(error, "invalid_goal_amount"), String(error));
        assert.deepEqual(error.details, { field: "amountCents" });
        return true;
      });
    }
    // The goal the previous test set is left as it was.
    const goal = await getGoal(pool, workspaceId, categoryId);
    assert.equal(goal?.kind, "monthly");
    assert.equal(goal?.amountCents, 60000);
  });

  it("replaces a category's existing goal instead of adding a second one", async () => {
    await upsertGoal(pool, workspaceId, categoryId, {
      kind: "by_date",
      amountCents: 360_000,
      dueMonth: "2027-06",
    });
    const goal = await getGoal(pool, workspaceId, categoryId);
    assert.equal(goal?.kind, "by_date");
    assert.equal(goal?.dueMonth, "2027-06");

    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM goals WHERE workspace_id = $1 AND category_id = $2",
      [workspaceId, categoryId],
    );
    assert.equal(rows[0]?.count, "1");
  });

  it("deletes a goal", async () => {
    const removed = await deleteGoal(pool, workspaceId, categoryId);
    assert.equal(removed, true);
    assert.equal(await getGoal(pool, workspaceId, categoryId), undefined);
  });

  it("deleting an unknown goal reports false", async () => {
    assert.equal(await deleteGoal(pool, workspaceId, categoryId), false);
  });

  it("computes progress matching design.md's own worked example", async () => {
    // €3,600 for holidays by June 2027, €1,250 carried into September 2026, €200 assigned.
    await upsertGoal(pool, workspaceId, categoryId, { kind: "by_date", amountCents: 360_000, dueMonth: "2027-06" });

    // Give the category €1,250 carried over from August via an assignment dated in August...
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-08", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 125_000 }],
    });
    // ...and €200 assigned in September, the month whose progress we ask for.
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 20_000 }],
    });

    const progress = await getGoalProgress(pool, workspaceId, categoryId, "2026-09");
    assert.equal(progress?.asks, 23_500);
    assert.equal(progress?.missing, 3_500);
  });

  it("reports undefined progress when the category has no goal", async () => {
    await deleteGoal(pool, workspaceId, categoryId);
    const progress = await getGoalProgress(pool, workspaceId, categoryId, "2026-09");
    assert.equal(progress, undefined);
  });

  it("lists every goal's progress for a month, each the same as the per-category progress", async () => {
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Listing', 2) RETURNING id",
      [workspaceId],
    );
    const insertCategory = async (name: string, archived = false) =>
      (
        await pool.query<{ id: string }>(
          "INSERT INTO categories (workspace_id, group_id, name, sort_order, archived) VALUES ($1, $2, $3, 1, $4) RETURNING id",
          [workspaceId, group.rows[0]!.id, name, archived],
        )
      ).rows[0]!.id;
    const monthly = await insertCategory("Groceries");
    const repeating = await insertCategory("Insurance");
    const balance = await insertCategory("Buffer");
    const archived = await insertCategory("Old", true);
    const withoutGoal = await insertCategory("Nothing");
    await upsertGoal(pool, workspaceId, categoryId, { kind: "by_date", amountCents: 360_000, dueMonth: "2027-06" });
    await upsertGoal(pool, workspaceId, monthly, { kind: "monthly", amountCents: 40_000 });
    await upsertGoal(pool, workspaceId, repeating, { kind: "repeating", amountCents: 60_000, dueMonth: "2026-12", every: 6 });
    await upsertGoal(pool, workspaceId, balance, { kind: "balance", amountCents: 50_000 });
    await upsertGoal(pool, workspaceId, archived, { kind: "monthly", amountCents: 1_000 });

    const listed = await listGoalProgress(pool, workspaceId, "2026-09");
    const byCategory = new Map(listed.map((p) => [p.goal.categoryId, p]));
    assert.equal(listed.length, 5);
    assert.equal(byCategory.has(withoutGoal), false);
    for (const id of [categoryId, monthly, repeating, balance, archived]) {
      assert.deepEqual(byCategory.get(id), await getGoalProgress(pool, workspaceId, id, "2026-09"));
    }
  });

  it("lists nothing for a workspace without goals", async () => {
    const otherWorkspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Empty', 'EUR', 'UTC')", [
      otherWorkspace,
    ]);
    try {
      assert.deepEqual(await listGoalProgress(pool, otherWorkspace, "2026-09"), []);
    } finally {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspace]);
    }
  });
});
