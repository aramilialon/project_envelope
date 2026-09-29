import { computeTarget, previousMonth } from "@envelope/core";

import { createAssignmentBatch, listAssignmentTotals, type AssignmentEntryRecord } from "../assignments/repository.ts";
import { getBudgetMonth, type BudgetMonthResponse } from "../budget/repository.ts";
import { listCategories, listCategoryGroups, type CategoryRecord } from "../categories/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { listGoals, toCoreTarget } from "../goals/repository.ts";

export type QuickAssignMode = "fund_targets" | "cover_overspending" | "cover_card_debt" | "repeat_assigned" | "repeat_spent";

export type QuickAssignScope = { readonly kind: "all" } | { readonly kind: "group"; readonly groupId: string };

interface Desired {
  readonly categoryId: string;
  readonly amountCents: number;
}

async function desiredAmounts(
  db: DbPool | DbClient,
  workspaceId: string,
  month: string,
  mode: QuickAssignMode,
  budgetMonth: BudgetMonthResponse,
): Promise<Desired[]> {
  switch (mode) {
    case "fund_targets": {
      const goals = await listGoals(db, workspaceId);
      const desired: Desired[] = [];
      for (const category of budgetMonth.categories) {
        const goal = goals.find((g) => g.categoryId === category.categoryId);
        if (!goal) continue;
        const state = { carried: category.carriedOver, assigned: category.assigned, available: category.available };
        const { missing } = computeTarget(toCoreTarget(goal), state, month);
        if (missing > 0) desired.push({ categoryId: category.categoryId, amountCents: missing });
      }
      return desired;
    }
    case "cover_overspending":
      return budgetMonth.categories
        .filter((c) => c.available < 0)
        .map((c) => ({ categoryId: c.categoryId, amountCents: -c.available }));
    case "cover_card_debt":
      return budgetMonth.paymentCategories
        .filter((c) => c.uncovered > 0)
        .map((c) => ({ categoryId: c.categoryId, amountCents: c.uncovered }));
    case "repeat_assigned": {
      const priorMonth = previousMonth(month);
      const totals = await listAssignmentTotals(db, workspaceId);
      return budgetMonth.categories
        .map((c): Desired => {
          const prior = totals.find((t) => t.categoryId === c.categoryId && t.month === priorMonth);
          return { categoryId: c.categoryId, amountCents: prior?.amountCents ?? 0 };
        })
        .filter((d) => d.amountCents > 0);
    }
    case "repeat_spent": {
      const priorMonth = previousMonth(month);
      const priorBudgetMonth = await getBudgetMonth(db, workspaceId, priorMonth);
      return budgetMonth.categories
        .map((c): Desired => {
          const prior = priorBudgetMonth.categories.find((p) => p.categoryId === c.categoryId);
          return { categoryId: c.categoryId, amountCents: prior ? -prior.activity : 0 };
        })
        .filter((d) => d.amountCents > 0);
    }
  }
}

/** Group sort order, then category sort order within it — the same order the budget month's own table renders in. */
function tableOrder(categories: readonly CategoryRecord[], groupSortOrder: ReadonlyMap<string, number>) {
  return (a: Desired, b: Desired): number => {
    const categoryA = categories.find((c) => c.id === a.categoryId);
    const categoryB = categories.find((c) => c.id === b.categoryId);
    const groupA = groupSortOrder.get(categoryA?.groupId ?? "") ?? 0;
    const groupB = groupSortOrder.get(categoryB?.groupId ?? "") ?? 0;
    if (groupA !== groupB) return groupA - groupB;
    return (categoryA?.sortOrder ?? 0) - (categoryB?.sortOrder ?? 0);
  };
}

/**
 * Quick assign (design.md, "Budget month on the desktop"): one ledger entry
 * (#15) per category that gets money, all sharing a single `batch_id`, so
 * the whole action undoes together. When unassigned money does not cover
 * every category the mode would otherwise fund, categories are funded in
 * table order until it runs out — never partially, in some other priority
 * order.
 */
export async function runQuickAssign(
  db: DbPool | DbClient,
  workspaceId: string,
  author: string,
  month: string,
  scope: QuickAssignScope,
  mode: QuickAssignMode,
): Promise<AssignmentEntryRecord[]> {
  const categories = await listCategories(db, workspaceId);
  const groups = await listCategoryGroups(db, workspaceId);
  const groupSortOrder = new Map(groups.map((g): [string, number] => [g.id, g.sortOrder]));

  const inScope = (categoryId: string): boolean => {
    if (scope.kind === "all") return true;
    return categories.find((c) => c.id === categoryId)?.groupId === scope.groupId;
  };

  const budgetMonth = await getBudgetMonth(db, workspaceId, month);
  const desired = (await desiredAmounts(db, workspaceId, month, mode, budgetMonth))
    .filter((d) => inScope(d.categoryId))
    .sort(tableOrder(categories, groupSortOrder));

  let remaining = budgetMonth.unassigned;
  const entries: { month: string; sourceCategoryId: null; destinationCategoryId: string; amountCents: number }[] = [];
  for (const d of desired) {
    if (remaining <= 0) break;
    const give = Math.min(d.amountCents, remaining);
    entries.push({ month, sourceCategoryId: null, destinationCategoryId: d.categoryId, amountCents: give });
    remaining -= give;
  }

  if (entries.length === 0) {
    return [];
  }
  return createAssignmentBatch(db, { workspaceId, author, entries });
}
