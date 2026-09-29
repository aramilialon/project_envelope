import { computeDaysOfBuffer, type BufferAccount, type CashMovement } from "@envelope/core";

import { listAccounts } from "../accounts/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { listTransactionsForWorkspace, type TransactionRecord } from "../transactions/repository.ts";

/** A transaction's own total: the sum of its splits. */
function totalOf(transaction: TransactionRecord): number {
  return transaction.splits.reduce((sum, split) => sum + split.amountCents, 0);
}

/**
 * Wires the workspace's accounts and transaction history into `packages/core`'s
 * `computeDaysOfBuffer` (#20).
 */
export async function getDaysOfBuffer(db: DbPool | DbClient, workspaceId: string, asOf: string): Promise<number> {
  const accounts = await listAccounts(db, workspaceId);
  const transactions = await listTransactionsForWorkspace(db, workspaceId);

  const bufferAccounts: BufferAccount[] = accounts.map((a) => ({ id: a.id, onBudget: a.onBudget }));
  const accountByTransactionId = new Map(transactions.map((t): [string, string] => [t.id, t.accountId]));
  const movements: CashMovement[] = transactions.map((t) => {
    const transferAccountId = t.transferId !== null ? accountByTransactionId.get(t.transferId) : undefined;
    return {
      accountId: t.accountId,
      date: t.budgetDate,
      amount: totalOf(t),
      ...(transferAccountId !== undefined ? { transferAccountId } : {}),
    };
  });

  return computeDaysOfBuffer(bufferAccounts, movements, asOf);
}

/** "Today" in the workspace's own time zone — the default `asOf` when the caller does not give one. */
export async function getCurrentDate(db: DbPool | DbClient, workspaceId: string): Promise<string> {
  const { rows } = await db.query<{ today: string }>(
    "SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS today FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`getCurrentDate: workspace "${workspaceId}" not found`);
  }
  return row.today;
}
