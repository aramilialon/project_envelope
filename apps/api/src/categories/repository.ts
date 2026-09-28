import type { DbClient, DbPool } from "../db/pool.ts";

export interface CategoryGroupRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly archived: boolean;
}

export interface CategoryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly groupId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly archived: boolean;
}

interface CategoryGroupRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly archived: boolean;
}

interface CategoryRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly group_id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly archived: boolean;
}

const GROUP_COLUMNS = "id, workspace_id, name, sort_order, archived";
const CATEGORY_COLUMNS = "id, workspace_id, group_id, name, sort_order, archived";

export async function createCategoryGroup(
  db: DbPool | DbClient,
  workspaceId: string,
  name: string,
): Promise<CategoryGroupRecord> {
  const { rows } = await db.query<CategoryGroupRow>(
    `INSERT INTO category_groups (workspace_id, name, sort_order)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM category_groups WHERE workspace_id = $1))
     RETURNING ${GROUP_COLUMNS}`,
    [workspaceId, name],
  );
  const group = rows[0];
  if (!group) {
    throw new Error("createCategoryGroup: INSERT ... RETURNING produced no row");
  }
  return toGroupRecord(group);
}

export async function getCategoryGroup(
  db: DbPool | DbClient,
  workspaceId: string,
  groupId: string,
): Promise<CategoryGroupRecord | undefined> {
  const { rows } = await db.query<CategoryGroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM category_groups WHERE id = $1 AND workspace_id = $2`,
    [groupId, workspaceId],
  );
  return rows[0] ? toGroupRecord(rows[0]) : undefined;
}

export async function listCategoryGroups(db: DbPool | DbClient, workspaceId: string): Promise<CategoryGroupRecord[]> {
  const { rows } = await db.query<CategoryGroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM category_groups WHERE workspace_id = $1 ORDER BY sort_order`,
    [workspaceId],
  );
  return rows.map(toGroupRecord);
}

export async function archiveCategoryGroup(
  db: DbPool | DbClient,
  workspaceId: string,
  groupId: string,
): Promise<CategoryGroupRecord | undefined> {
  const { rows } = await db.query<CategoryGroupRow>(
    `UPDATE category_groups SET archived = true WHERE id = $1 AND workspace_id = $2 RETURNING ${GROUP_COLUMNS}`,
    [groupId, workspaceId],
  );
  return rows[0] ? toGroupRecord(rows[0]) : undefined;
}

/** Reorders every group of a workspace in one transaction. `groupIds` must be exactly the workspace's current groups, in the new order. */
export async function reorderCategoryGroups(
  db: DbPool | DbClient,
  workspaceId: string,
  groupIds: readonly string[],
): Promise<boolean> {
  const current = await db.query<{ id: string }>("SELECT id FROM category_groups WHERE workspace_id = $1", [
    workspaceId,
  ]);
  if (!sameIds(current.rows.map((r) => r.id), groupIds)) {
    return false;
  }
  for (const [index, id] of groupIds.entries()) {
    await db.query("UPDATE category_groups SET sort_order = $1 WHERE id = $2 AND workspace_id = $3", [
      index + 1,
      id,
      workspaceId,
    ]);
  }
  return true;
}

export async function createCategory(
  db: DbPool | DbClient,
  workspaceId: string,
  groupId: string,
  name: string,
): Promise<CategoryRecord> {
  const { rows } = await db.query<CategoryRow>(
    `INSERT INTO categories (workspace_id, group_id, name, sort_order)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE group_id = $2))
     RETURNING ${CATEGORY_COLUMNS}`,
    [workspaceId, groupId, name],
  );
  const category = rows[0];
  if (!category) {
    throw new Error("createCategory: INSERT ... RETURNING produced no row");
  }
  return toCategoryRecord(category);
}

export async function listCategories(db: DbPool | DbClient, workspaceId: string): Promise<CategoryRecord[]> {
  const { rows } = await db.query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE workspace_id = $1 ORDER BY group_id, sort_order`,
    [workspaceId],
  );
  return rows.map(toCategoryRecord);
}

export async function archiveCategory(
  db: DbPool | DbClient,
  workspaceId: string,
  categoryId: string,
): Promise<CategoryRecord | undefined> {
  const { rows } = await db.query<CategoryRow>(
    `UPDATE categories SET archived = true WHERE id = $1 AND workspace_id = $2 RETURNING ${CATEGORY_COLUMNS}`,
    [categoryId, workspaceId],
  );
  return rows[0] ? toCategoryRecord(rows[0]) : undefined;
}

/** Reorders every category of one group in one transaction. `categoryIds` must be exactly that group's current categories, in the new order. */
export async function reorderCategories(
  db: DbPool | DbClient,
  workspaceId: string,
  groupId: string,
  categoryIds: readonly string[],
): Promise<boolean> {
  const current = await db.query<{ id: string }>(
    "SELECT id FROM categories WHERE workspace_id = $1 AND group_id = $2",
    [workspaceId, groupId],
  );
  if (!sameIds(current.rows.map((r) => r.id), categoryIds)) {
    return false;
  }
  for (const [index, id] of categoryIds.entries()) {
    await db.query("UPDATE categories SET sort_order = $1 WHERE id = $2 AND workspace_id = $3 AND group_id = $4", [
      index + 1,
      id,
      workspaceId,
      groupId,
    ]);
  }
  return true;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

function toGroupRecord(row: CategoryGroupRow): CategoryGroupRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    sortOrder: row.sort_order,
    archived: row.archived,
  };
}

function toCategoryRecord(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    groupId: row.group_id,
    name: row.name,
    sortOrder: row.sort_order,
    archived: row.archived,
  };
}
