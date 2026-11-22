import {
  aggregateTransactions,
  computeBudgetMonth,
  computeBudgetProblems,
  UNASSIGNED,
  type Assignment,
  type BudgetAccount,
  type BudgetProblem,
  type BudgetTransaction,
  type CardBalance,
  type CardTransaction,
  type CategoryMonth,
  type Split,
} from "@envelope/core";

import { listAssignmentTotals } from "../assignments/repository.ts";
import { listAccounts, type AccountRecord, type AccountType } from "../accounts/repository.ts";
import { listCategories, listCategoryGroups, type CategoryGroupRecord, type CategoryRecord } from "../categories/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { getCurrentDate } from "../days-of-buffer/repository.ts";
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
  /** Payment categories only (#355): which ordinary categories' credit overspending this month is attributable to this card, joined with each one's own name. */
  readonly overspendingBy?: readonly { readonly categoryId: string; readonly name: string; readonly amount: number }[];
  /** Payment categories only (#355): whether the card had a starting balance when added. */
  readonly hasStartingBalance?: boolean;
  /** Payment categories only (#699): the card's real balance at the end of the month, what is owed on it — the debt the interface shows. */
  readonly owed?: number;
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

/**
 * `@envelope/core` only tells a credit card apart from every other kind of
 * account. Exhaustive on purpose: a new `AccountType` fails to compile here
 * until someone decides which of the two it is. A brokerage account (#74) is
 * always off budget, so `aggregateTransactions` skips it either way.
 */
const BUDGET_ACCOUNT_TYPES: Readonly<Record<AccountType, BudgetAccount["type"]>> = {
  checking: "cash",
  savings: "cash",
  cash: "cash",
  credit_card: "credit",
  brokerage: "cash",
};

function toBudgetAccount(account: AccountRecord): BudgetAccount {
  return {
    id: account.id,
    type: BUDGET_ACCOUNT_TYPES[account.type],
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
    // Usually null (a transfer between two on-budget accounts, or a card payment, needs no
    // category), but a transfer to or from an off-budget account carries one on its on-budget
    // leg (#378) — `packages/core` needs it to treat that leg as ordinary activity.
    const categoryId = transaction.splits.length === 1 ? (transaction.splits[0]?.categoryId ?? null) : null;
    return {
      id: transaction.id,
      accountId: transaction.accountId,
      date: transaction.budgetDate,
      amount,
      ...(transferAccountId !== undefined ? { transferAccountId } : {}),
      ...(categoryId !== null ? { categoryId } : {}),
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
 * feeds only the card's balance (`CardBalance.transactions`, read by core's
 * `owedAsOf`), never `aggregateTransactions`, which would otherwise reject it (a payment category is never a valid `Activity.categoryId`). The
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
 * A credit card's own account transactions, every one of them, starting balance included: core
 * reads the card's real balance at the end of each month from them (`owedAsOf`, #660), never from
 * activity or card payments.
 */
function cardTransactionsOf(transactions: readonly TransactionRecord[], accountId: string): CardTransaction[] {
  return transactions.filter((t) => t.accountId === accountId).map((t) => ({ date: t.budgetDate, amount: totalOf(t) }));
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
    ...(categoryMonth.overspendingBy !== undefined
      ? {
          overspendingBy: categoryMonth.overspendingBy.map((o) => ({
            categoryId: o.categoryId,
            name: categoriesById.get(o.categoryId)?.name ?? "",
            amount: o.amount,
          })),
        }
      : {}),
    ...(categoryMonth.hasStartingBalance !== undefined ? { hasStartingBalance: categoryMonth.hasStartingBalance } : {}),
    ...(categoryMonth.owed !== undefined ? { owed: categoryMonth.owed } : {}),
  };
}

/**
 * Wires accounts, categorized activity, the assignment ledger (#15) and the month's own
 * not-yet-recorded scheduled transactions (#22, #250) into `packages/core`'s
 * `computeBudgetMonth`, joined with each category's name, group and sort order.
 * `computeBudgetMonth` recomputes every month since the workspace's first data to get
 * rollover right, so this loads every transaction and assignment unconditionally, not just
 * `month`'s own — accepted for now (no pagination or date-bounding), worth revisiting if it
 * becomes a real cost. Income dated after today, in the workspace's time zone, is not received
 * yet and counts nowhere (#650): every caller (budget screen, problems, quick-assign, targets,
 * the notifications job) gets the same today from here.
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
    .map((a) => ({
      paymentCategoryId: a.paymentCategoryId as string,
      transactions: cardTransactionsOf(transactions, a.id),
      hasStartingBalance: transactions.some((t) => t.accountId === a.id && isStartingBalance(t, paymentCategoryIdByAccountId)),
    }));

  const assignments: Assignment[] = assignmentTotals.map((t) => ({
    categoryId: t.categoryId,
    month: t.month,
    amount: t.amountCents,
  }));
  const scheduledItems = await listReservationsForMonth(db, workspaceId, month);
  const today = await getCurrentDate(db, workspaceId);

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
      today,
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
