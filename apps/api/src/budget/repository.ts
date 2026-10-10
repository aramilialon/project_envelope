import {
  aggregateTransactions,
  compareMonths,
  computeBudgetMonth,
  computeBudgetProblems,
  monthOf,
  UNASSIGNED,
  type Assignment,
  type BudgetAccount,
  type BudgetProblem,
  type BudgetTransaction,
  type CardBalance,
  type CategoryMonth,
  type Split,
} from "@envelope/core";

import { listAssignmentTotals } from "../assignments/repository.ts";
import { listAccounts, type AccountRecord } from "../accounts/repository.ts";
import { listCategories, listCategoryGroups, type CategoryGroupRecord, type CategoryRecord } from "../categories/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { listReservationsForMonth } from "../scheduled-transactions/repository.ts";
import { isStartingBalanceSplit, listTransactionsForWorkspace, type TransactionRecord } from "../transactions/repository.ts";

export interface BudgetMonthCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly sortOrder: number;
  readonly carriedOver: number;
  readonly assigned: number;
  readonly activity: number;
  readonly available: number;
  readonly creditOverspending: number;
  readonly cashOverspending: number;
  readonly reserved: number;
  readonly uncovered: number;
}

export interface BudgetMonthResponse {
  readonly month: string;
  readonly unassigned: number;
  readonly assignedInFuture: number;
  readonly overspentLastMonth: number;
  readonly creditOverspending: number;
  readonly reserved: number;
  readonly categories: readonly BudgetMonthCategory[];
  readonly paymentCategories: readonly BudgetMonthCategory[];
}

function toBudgetAccount(account: AccountRecord): BudgetAccount {
  return {
    id: account.id,
    type: account.type === "credit_card" ? "credit" : "cash",
    onBudget: account.onBudget,
    ...(account.paymentCategoryId ? { paymentCategoryId: account.paymentCategoryId } : {}),
  };
}

/**
 * A transaction's own total: the sum of its splits, its only defined
 * "amount" (there is no separate stored total on `transactions` itself).
 */
function totalOf(transaction: TransactionRecord): number {
  return transaction.splits.reduce((sum, split) => sum + split.amountCents, 0);
}

function toBudgetTransaction(transaction: TransactionRecord, accountByTransactionId: ReadonlyMap<string, string>): BudgetTransaction {
  const amount = totalOf(transaction);
  if (transaction.transferId !== null) {
    const transferAccountId = accountByTransactionId.get(transaction.transferId);
    return {
      id: transaction.id,
      accountId: transaction.accountId,
      date: transaction.budgetDate,
      amount,
      ...(transferAccountId !== undefined ? { transferAccountId } : {}),
    };
  }
  if (transaction.splits.length === 1 && transaction.splits[0]?.categoryId === null) {
    return { id: transaction.id, accountId: transaction.accountId, date: transaction.budgetDate, amount, categoryId: UNASSIGNED };
  }
  const splits: Split[] = transaction.splits.map((split) => ({
    categoryId: split.categoryId as string,
    amount: split.amountCents,
  }));
  return { id: transaction.id, accountId: transaction.accountId, date: transaction.budgetDate, amount, splits };
}

/**
 * A card's starting balance (`accounts/repository.ts`'s `createStartingBalanceTransaction`)
 * is a single split whose own category is that same card's payment category —
 * the one combination no ordinary transaction produces (spending uses a
 * regular category; a card payment is a transfer with no category at all).
 * `packages/core`'s own docs are explicit that this is not an `Activity`: it
 * feeds only `owedAsOf`, never `aggregateTransactions`, which would otherwise
 * reject it (a payment category is never a valid `Activity.categoryId`). The
 * rule itself (`isStartingBalanceSplit`) lives in `transactions/repository.ts`,
 * shared with `listTransactionEventsForMonth`'s own exclusion of the same thing (#326).
 */
function isStartingBalance(transaction: TransactionRecord, paymentCategoryIdByAccountId: ReadonlyMap<string, string | null>): boolean {
  return isStartingBalanceSplit({
    transferId: transaction.transferId,
    splitCount: transaction.splits.length,
    categoryId: transaction.splits.length === 1 ? (transaction.splits[0]?.categoryId ?? null) : null,
    paymentCategoryId: paymentCategoryIdByAccountId.get(transaction.accountId) ?? null,
  });
}

/**
 * A credit card's real, external balance as of `month` (inclusive): the sum
 * of its own account's transactions dated up to and including that month —
 * never derived from activity or card payments (`packages/core`'s own
 * `CardBalance` doc). Positive = owed.
 */
function owedAsOf(transactions: readonly TransactionRecord[], accountId: string, month: string): number {
  let balance = 0;
  for (const transaction of transactions) {
    if (transaction.accountId !== accountId) continue;
    if (compareMonths(monthOf(transaction.budgetDate), month) > 0) continue;
    balance += totalOf(transaction);
  }
  return -balance;
}

function joinCategory(
  categoryMonth: CategoryMonth,
  categoriesById: ReadonlyMap<string, CategoryRecord>,
  groupsById: ReadonlyMap<string, CategoryGroupRecord>,
): BudgetMonthCategory {
  const category = categoriesById.get(categoryMonth.categoryId);
  if (!category) {
    throw new Error(`getBudgetMonth: category "${categoryMonth.categoryId}" not found (should never happen)`);
  }
  const group = groupsById.get(category.groupId);
  return {
    categoryId: categoryMonth.categoryId,
    name: category.name,
    groupId: category.groupId,
    groupName: group?.name ?? "",
    sortOrder: category.sortOrder,
    carriedOver: categoryMonth.carriedOver,
    assigned: categoryMonth.assigned,
    activity: categoryMonth.activity,
    available: categoryMonth.available,
    creditOverspending: categoryMonth.creditOverspending,
    cashOverspending: categoryMonth.cashOverspending,
    reserved: categoryMonth.reserved,
    uncovered: categoryMonth.uncovered,
  };
}

/**
 * Wires accounts, categorized activity, the assignment ledger (#15) and the month's own
 * not-yet-recorded scheduled transactions (#22, #250) into `packages/core`'s
 * `computeBudgetMonth`, joined with each category's name, group and sort order.
 * `computeBudgetMonth` recomputes every month since the workspace's first data to get
 * rollover right, so this loads every transaction and assignment unconditionally, not just
 * `month`'s own — accepted for now (no pagination or date-bounding), worth revisiting if it
 * becomes a real cost.
 */
export async function getBudgetMonth(db: DbPool | DbClient, workspaceId: string, month: string): Promise<BudgetMonthResponse> {
  // Sequential, not Promise.all: `db` is often a single request-scoped `PoolClient`
  // (workspace-membership.ts), which cannot run more than one query at a time.
  const accounts = await listAccounts(db, workspaceId);
  const categories = await listCategories(db, workspaceId);
  const groups = await listCategoryGroups(db, workspaceId);
  const transactions = await listTransactionsForWorkspace(db, workspaceId);
  const assignmentTotals = await listAssignmentTotals(db, workspaceId);

  const accountByTransactionId = new Map(transactions.map((t): [string, string] => [t.id, t.accountId]));
  const paymentCategoryIdByAccountId = new Map(accounts.map((a): [string, string | null] => [a.id, a.paymentCategoryId]));
  const budgetAccounts = accounts.map(toBudgetAccount);
  const budgetTransactions = transactions
    .filter((t) => !isStartingBalance(t, paymentCategoryIdByAccountId))
    .map((t) => toBudgetTransaction(t, accountByTransactionId));
  const aggregated = aggregateTransactions(budgetAccounts, budgetTransactions);

  const paymentCategoryIds = accounts
    .map((a) => a.paymentCategoryId)
    .filter((id): id is string => id !== null);
  const paymentCategoryIdSet = new Set(paymentCategoryIds);
  const categoryIds = categories.map((c) => c.id).filter((id) => !paymentCategoryIdSet.has(id));

  const cardBalances: CardBalance[] = accounts
    .filter((a) => a.paymentCategoryId !== null)
    .map((a) => ({ paymentCategoryId: a.paymentCategoryId as string, owed: owedAsOf(transactions, a.id, month) }));

  const assignments: Assignment[] = assignmentTotals.map((t) => ({
    categoryId: t.categoryId,
    month: t.month,
    amount: t.amountCents,
  }));
  const scheduledItems = await listReservationsForMonth(db, workspaceId, month);

  const budgetMonth = computeBudgetMonth(
    {
      categoryIds,
      paymentCategoryIds,
      income: aggregated.income,
      assignments,
      activity: aggregated.activity,
      cardPayments: aggregated.cardPayments,
      cardTransfers: aggregated.cardTransfers,
      cardBalances,
      scheduledItems,
    },
    month,
  );

  const categoriesById = new Map(categories.map((c): [string, CategoryRecord] => [c.id, c]));
  const groupsById = new Map(groups.map((g): [string, CategoryGroupRecord] => [g.id, g]));

  return {
    month: budgetMonth.month,
    unassigned: budgetMonth.unassigned,
    assignedInFuture: budgetMonth.assignedInFuture,
    overspentLastMonth: budgetMonth.overspentLastMonth,
    creditOverspending: budgetMonth.creditOverspending,
    reserved: budgetMonth.reserved,
    categories: budgetMonth.categories.map((c) => joinCategory(c, categoriesById, groupsById)),
    paymentCategories: budgetMonth.paymentCategories.map((c) => joinCategory(c, categoriesById, groupsById)),
  };
}

export type { BudgetProblem, BudgetProblemKind } from "@envelope/core";

/**
 * The current issues a workspace/month has that need an owner or editor to act on (#23):
 * derived entirely from the same `getBudgetMonth` computation — no separate stored "problem"
 * state (design.md: "derived values are never the source of truth"). The derivation itself is
 * `@envelope/core`'s own `computeBudgetProblems` (`#61`): the same rule `apps/web` applies
 * locally to its own already-fetched budget month, for an instant, offline-capable alert
 * (design.md, "Notifications": "computed locally by the shared core, even offline").
 */
export async function listBudgetProblems(db: DbPool | DbClient, workspaceId: string, month: string): Promise<BudgetProblem[]> {
  const budgetMonth = await getBudgetMonth(db, workspaceId, month);
  return computeBudgetProblems({
    unassigned: budgetMonth.unassigned,
    categories: [...budgetMonth.categories, ...budgetMonth.paymentCategories],
  });
}
