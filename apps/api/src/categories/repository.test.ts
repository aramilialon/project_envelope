import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import {
  archiveCategory,
  archiveCategoryGroup,
  createCategory,
  createCategoryGroup,
  listCategories,
  listCategoryGroups,
  reorderCategories,
  reorderCategoryGroups,
} from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("categories repository", () => {
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

  it("creates category groups with increasing sort_order", async () => {
    const first = await createCategoryGroup(pool, workspaceId, "Home");
    const second = await createCategoryGroup(pool, workspaceId, "Fun");
    assert.equal(first.archived, false);
    assert.ok(second.sortOrder > first.sortOrder);
  });

  it("creates categories within a group, with increasing sort_order per group", async () => {
    const group = await createCategoryGroup(pool, workspaceId, "Bills");
    const rent = await createCategory(pool, workspaceId, group.id, "Rent");
    const electricity = await createCategory(pool, workspaceId, group.id, "Electricity");
    assert.equal(rent.groupId, group.id);
    assert.ok(electricity.sortOrder > rent.sortOrder);
  });

  it("archives a group and a category without deleting them", async () => {
    const group = await createCategoryGroup(pool, workspaceId, "To archive");
    const category = await createCategory(pool, workspaceId, group.id, "Also to archive");

    const archivedGroup = await archiveCategoryGroup(pool, workspaceId, group.id);
    const archivedCategory = await archiveCategory(pool, workspaceId, category.id);

    assert.equal(archivedGroup?.archived, true);
    assert.equal(archivedCategory?.archived, true);
    const stillListed = await listCategories(pool, workspaceId);
    assert.ok(stillListed.some((c) => c.id === category.id));
  });

  it("archiving an unknown group or category finds nothing", async () => {
    assert.equal(await archiveCategoryGroup(pool, workspaceId, randomUUID()), undefined);
    assert.equal(await archiveCategory(pool, workspaceId, randomUUID()), undefined);
  });

  it("reorders every category group of a workspace in one go", async () => {
    const localWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Reorder groups', 'EUR', 'Europe/Rome')", [
      localWorkspaceId,
    ]);
    const a = await createCategoryGroup(pool, localWorkspaceId, "A");
    const b = await createCategoryGroup(pool, localWorkspaceId, "B");

    const ok = await reorderCategoryGroups(pool, localWorkspaceId, [b.id, a.id]);
    assert.equal(ok, true);

    const groups = await listCategoryGroups(pool, localWorkspaceId);
    assert.deepEqual(groups.map((g) => g.id), [b.id, a.id]);

    await pool.query("DELETE FROM workspaces WHERE id = $1", [localWorkspaceId]);
  });

  it("rejects reordering groups when the id set does not match exactly", async () => {
    const localWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mismatch', 'EUR', 'Europe/Rome')", [
      localWorkspaceId,
    ]);
    const a = await createCategoryGroup(pool, localWorkspaceId, "A");

    const ok = await reorderCategoryGroups(pool, localWorkspaceId, [a.id, randomUUID()]);
    assert.equal(ok, false);

    await pool.query("DELETE FROM workspaces WHERE id = $1", [localWorkspaceId]);
  });

  it("reorders every category of one group in one go, leaving other groups alone", async () => {
    const group = await createCategoryGroup(pool, workspaceId, "Reorder me");
    const otherGroup = await createCategoryGroup(pool, workspaceId, "Untouched");
    const x = await createCategory(pool, workspaceId, group.id, "X");
    const y = await createCategory(pool, workspaceId, group.id, "Y");
    const untouched = await createCategory(pool, workspaceId, otherGroup.id, "Z");

    const ok = await reorderCategories(pool, workspaceId, group.id, [y.id, x.id]);
    assert.equal(ok, true);

    const categories = await listCategories(pool, workspaceId);
    const reordered = categories.filter((c) => c.groupId === group.id);
    assert.deepEqual(reordered.map((c) => c.id), [y.id, x.id]);
    assert.equal(categories.find((c) => c.id === untouched.id)?.sortOrder, 1);
  });

  it("rejects reordering categories when the id set does not match the group exactly", async () => {
    const group = await createCategoryGroup(pool, workspaceId, "Mismatch group");
    const x = await createCategory(pool, workspaceId, group.id, "X");

    const ok = await reorderCategories(pool, workspaceId, group.id, [x.id, randomUUID()]);
    assert.equal(ok, false);
  });
});
