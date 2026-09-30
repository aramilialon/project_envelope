import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { BudgetProblem } from "../budget/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { reconcileNotifiedProblems } from "./notified-problems.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("reconcileNotifiedProblems (#40)", () => {
  let pool: DbPool;
  let workspaceId: string;
  let categoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const workspace = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Test', 'EUR', 'UTC') RETURNING id",
    );
    workspaceId = workspace.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  function overspent(amountCents: number): BudgetProblem {
    return { kind: "overspent_category", categoryId, name: "Groceries", groupName: "Home", amountCents };
  }

  it("treats a problem seen for the first time as changed", async () => {
    const month = "2026-01";
    const changed = await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000)]);
    assert.deepEqual(changed, [overspent(5_000)]);
  });

  it("does not repeat a problem whose amount has not moved since last time", async () => {
    const month = "2026-02";
    await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000)]);
    const changed = await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000)]);
    assert.deepEqual(changed, []);
  });

  it("treats a problem whose amount changed as changed again", async () => {
    const month = "2026-03";
    await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000)]);
    const changed = await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(7_500)]);
    assert.deepEqual(changed, [overspent(7_500)]);
  });

  it("treats a resolved-then-reappeared problem as new again", async () => {
    const month = "2026-04";
    await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000)]);
    await reconcileNotifiedProblems(pool, workspaceId, month, []); // resolved
    const changed = await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000)]);
    assert.deepEqual(changed, [overspent(5_000)], "a problem that reappears after resolving must count as new, not unchanged");
  });

  it("tracks unassigned_money (no category) independently of a category problem in the same month", async () => {
    const month = "2026-05";
    const unassigned: BudgetProblem = { kind: "unassigned_money", amountCents: 12_000 };
    const first = await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000), unassigned]);
    assert.deepEqual(
      first.map((p) => p.kind).sort(),
      ["overspent_category", "unassigned_money"],
    );
    const second = await reconcileNotifiedProblems(pool, workspaceId, month, [overspent(5_000), unassigned]);
    assert.deepEqual(second, []);
  });
});
