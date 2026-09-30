/**
 * Tracks each workspace/month's last-known budget problems (#40), so the
 * budget-recompute job notifies members only when a problem is new or its
 * amount has changed. See migrations/0019_notified_budget_problems.sql for
 * why this is a find-then-write, not a DB unique constraint.
 */
import type { BudgetProblem } from "../budget/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";

interface NotifiedProblemRow {
  readonly id: string;
  readonly kind: string;
  readonly category_id: string | null;
  readonly amount_cents: string;
}

function problemKey(kind: string, categoryId: string | null): string {
  return `${kind}:${categoryId ?? ""}`;
}

/**
 * Compares `problems` against the workspace/month's last-known state, returns only the ones
 * that are new or whose amount changed, and overwrites that state to match `problems` exactly
 * (a problem no longer present is deleted, so if it reappears later it counts as new again).
 */
export async function reconcileNotifiedProblems(
  db: DbPool | DbClient,
  workspaceId: string,
  month: string,
  problems: readonly BudgetProblem[],
): Promise<BudgetProblem[]> {
  const { rows: existing } = await db.query<NotifiedProblemRow>(
    "SELECT id, kind, category_id, amount_cents FROM notified_budget_problems WHERE workspace_id = $1 AND month = ($2 || '-01')::date",
    [workspaceId, month],
  );
  const existingByKey = new Map(existing.map((row) => [problemKey(row.kind, row.category_id), row]));
  const currentKeys = new Set(problems.map((problem) => problemKey(problem.kind, problem.categoryId ?? null)));

  const changed: BudgetProblem[] = [];
  for (const problem of problems) {
    const key = problemKey(problem.kind, problem.categoryId ?? null);
    const existingRow = existingByKey.get(key);
    if (!existingRow) {
      await db.query(
        "INSERT INTO notified_budget_problems (workspace_id, month, kind, category_id, amount_cents) VALUES ($1, ($2 || '-01')::date, $3, $4, $5)",
        [workspaceId, month, problem.kind, problem.categoryId ?? null, problem.amountCents],
      );
      changed.push(problem);
    } else if (Number(existingRow.amount_cents) !== problem.amountCents) {
      await db.query("UPDATE notified_budget_problems SET amount_cents = $1, updated_at = now() WHERE id = $2", [
        problem.amountCents,
        existingRow.id,
      ]);
      changed.push(problem);
    }
  }

  const resolved = existing.filter((row) => !currentKeys.has(problemKey(row.kind, row.category_id)));
  for (const row of resolved) {
    await db.query("DELETE FROM notified_budget_problems WHERE id = $1", [row.id]);
  }

  return changed;
}
