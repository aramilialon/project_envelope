import { assertCents, assertMonth, computeTarget, type Target } from "@envelope/core";

import { getBudgetMonth } from "../budget/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";

export type GoalKind = "monthly" | "by_date" | "repeating" | "balance";
export type RepeatInterval = 2 | 3 | 4 | 6 | 12 | 24;

export interface GoalInput {
  readonly kind: GoalKind;
  readonly amountCents: number;
  /** Required for "by_date" and "repeating", forbidden otherwise. */
  readonly dueMonth?: string;
  /** Required for "repeating", forbidden otherwise. */
  readonly every?: RepeatInterval;
}

export interface GoalRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly categoryId: string;
  readonly kind: GoalKind;
  readonly amountCents: number;
  readonly dueMonth: string | null;
  readonly every: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalProgress {
  readonly goal: GoalRecord;
  /** What the goal asks for this month. */
  readonly asks: number;
  /** Still missing this month, at least 0 — "amount still needed" (#18). */
  readonly missing: number;
  /** 0..1 fraction; not clamped, so an exceeded goal reads above 1. */
  readonly progress: number;
}

interface GoalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly category_id: string;
  readonly kind: GoalKind;
  readonly amount_cents: string;
  readonly due_month: string | null;
  readonly every_months: number | null;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly created_at: Date;
  readonly updated_at: Date;
}

const GOAL_COLUMNS = `
  id, workspace_id, category_id, kind, amount_cents,
  to_char(due_month, 'YYYY-MM') AS due_month, every_months, created_at, updated_at
`;

function toGoalRecord(row: GoalRow): GoalRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    categoryId: row.category_id,
    kind: row.kind,
    amountCents: Number(row.amount_cents),
    dueMonth: row.due_month,
    every: row.every_months,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Creates or replaces the category's goal (a category has at most one at a
 * time: setting a new one replaces the old, it is not a history). Shape
 * validation (the right fields for `input.kind`) is the route's job, the
 * same split used for other request-shape checks in this codebase — the
 * migration's own CHECK constraint is the last line of defense.
 */
export async function upsertGoal(
  db: DbPool | DbClient,
  workspaceId: string,
  categoryId: string,
  input: GoalInput,
): Promise<GoalRecord> {
  assertCents(input.amountCents);
  if (input.dueMonth !== undefined) {
    assertMonth(input.dueMonth);
  }
  const dueMonthDate = input.dueMonth !== undefined ? `${input.dueMonth}-01` : null;
  const { rows } = await db.query<GoalRow>(
    `INSERT INTO goals (workspace_id, category_id, kind, amount_cents, due_month, every_months)
     VALUES ($1, $2, $3, $4, $5::date, $6)
     ON CONFLICT (category_id) DO UPDATE SET
       kind = EXCLUDED.kind, amount_cents = EXCLUDED.amount_cents,
       due_month = EXCLUDED.due_month, every_months = EXCLUDED.every_months, updated_at = now()
     RETURNING ${GOAL_COLUMNS}`,
    [workspaceId, categoryId, input.kind, input.amountCents, dueMonthDate, input.every ?? null],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("upsertGoal: INSERT ... RETURNING produced no row");
  }
  return toGoalRecord(row);
}

export async function getGoal(db: DbPool | DbClient, workspaceId: string, categoryId: string): Promise<GoalRecord | undefined> {
  const { rows } = await db.query<GoalRow>(
    `SELECT ${GOAL_COLUMNS} FROM goals WHERE workspace_id = $1 AND category_id = $2`,
    [workspaceId, categoryId],
  );
  const row = rows[0];
  return row ? toGoalRecord(row) : undefined;
}

export async function listGoals(db: DbPool | DbClient, workspaceId: string): Promise<GoalRecord[]> {
  const { rows } = await db.query<GoalRow>(`SELECT ${GOAL_COLUMNS} FROM goals WHERE workspace_id = $1`, [workspaceId]);
  return rows.map(toGoalRecord);
}

/** Returns true if a goal was found and removed. */
export async function deleteGoal(db: DbPool | DbClient, workspaceId: string, categoryId: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM goals WHERE workspace_id = $1 AND category_id = $2", [
    workspaceId,
    categoryId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Exported for #19 (quick assign), which computes progress for every category in scope at once. */
export function toCoreTarget(goal: GoalRecord): Target {
  switch (goal.kind) {
    case "monthly":
      return { kind: "monthly", amount: goal.amountCents };
    case "by_date":
      return { kind: "by_date", amount: goal.amountCents, dueMonth: goal.dueMonth as string };
    case "repeating":
      return {
        kind: "repeating",
        amount: goal.amountCents,
        dueMonth: goal.dueMonth as string,
        every: goal.every as 2 | 3 | 4 | 6 | 12 | 24,
      };
    case "balance":
      return { kind: "balance", threshold: goal.amountCents };
  }
}

/**
 * A category's goal joined with how much it still needs this month (#18):
 * the goal's own carried/assigned/available come from the same budget month
 * computation the budget endpoint (#16) already assembles.
 */
export async function getGoalProgress(
  db: DbPool | DbClient,
  workspaceId: string,
  categoryId: string,
  month: string,
): Promise<GoalProgress | undefined> {
  const goal = await getGoal(db, workspaceId, categoryId);
  if (!goal) {
    return undefined;
  }
  const budgetMonth = await getBudgetMonth(db, workspaceId, month);
  const category = [...budgetMonth.categories, ...budgetMonth.paymentCategories].find((c) => c.categoryId === categoryId);
  if (!category) {
    return undefined;
  }
  const state = { carried: category.carriedOver, assigned: category.assigned, available: category.available };
  const { asks, missing, progress } = computeTarget(toCoreTarget(goal), state, month);
  return { goal, asks, missing, progress };
}
