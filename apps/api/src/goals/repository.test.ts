import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createAssignmentBatch } from "../assignments/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { deleteGoal, getGoal, getGoalProgress, upsertGoal } from "./repository.ts";

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
});
