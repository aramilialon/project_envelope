import { amountNeededToCover, cardAmountAsked, cardPartsAskedOnCategories, computeTarget, MAX_AMOUNT_CENTS, shiftMonth } from "@envelope/core";

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
      // `amountNeededToCover` (#728, #731): a category's cash overspending plus its reservation
      // shortfall. Its credit overspending is already part of its card's uncovered debt and is
      // covered once: by "cover_card_debt", except when the category also has a reservation
      // shortfall — money assigned to it covers its card spending first, so it asks that too,
      // and its card asks that much less. The same figure as the category's "To do" item.
      return budgetMonth.categories
        .map((c) => ({ categoryId: c.categoryId, amountCents: amountNeededToCover(c) }))
        .filter((d) => d.amountCents > 0);
    case "cover_card_debt": {
      // `cardAmountAsked` (#699, #731): the card's whole to cover — a card paid beyond what was
      // set aside needs its cash overspending covered as well as its uncovered debt, in one run —
      // less the card spending asked on categories with a reservation shortfall, which
      // "cover_overspending" covers there; the same figure as the card's "To do" item, so running
      // both modes, in either order, never sets the same money aside twice. Payment categories
      // stay out of "cover_overspending", which reads `categories` only.
      const askedOnCategories = cardPartsAskedOnCategories(budgetMonth.categories, budgetMonth.paymentCategories);
      return budgetMonth.paymentCategories
        .map((c) => ({ categoryId: c.categoryId, amountCents: cardAmountAsked(c, askedOnCategories.get(c.categoryId) ?? []) }))
        .filter((d) => d.amountCents > 0);
    }
    case "repeat_assigned": {
      const priorMonth = shiftMonth(month, -1);
      const totals = await listAssignmentTotals(db, workspaceId);
      return budgetMonth.categories
        .map((c): Desired => {
          const prior = totals.find((t) => t.categoryId === c.categoryId && t.month === priorMonth);
          return { categoryId: c.categoryId, amountCents: prior?.amountCents ?? 0 };
        })
        .filter((d) => d.amountCents > 0);
    }
    case "repeat_spent": {
      const priorMonth = shiftMonth(month, -1);
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
 *
 * A category's computed amount can be beyond the cap on a single amount
 * (ADR 0002), for instance overspending made of several transactions that
 * are each within it. That amount is split, not refused: the category gets
 * several ledger entries of at most `MAX_AMOUNT_CENTS` each, in the same
 * batch, so they still undo together.
 */
export async function runQuickAssign(
  db: DbPool | DbClient,
  workspaceId: string,
  author: string,
  month: string,
  scope: QuickAssignScope,
  mode: QuickAssignMode,
  /** A batch id the client chose, already claimed with `claimAssignmentBatch` (#559). */
  batchId?: string,
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
    for (let left = give; left > 0; left -= MAX_AMOUNT_CENTS) {
      entries.push({ month, sourceCategoryId: null, destinationCategoryId: d.categoryId, amountCents: Math.min(left, MAX_AMOUNT_CENTS) });
    }
    remaining -= give;
  }

  if (entries.length === 0) {
    return [];
  }
  return createAssignmentBatch(db, { workspaceId, author, entries, ...(batchId !== undefined ? { batchId } : {}) });
}
