import type { BalanceRow } from "@envelope/core";

import type { Transaction } from "./api.ts";

/** A transaction's own total: the sum of its splits, its only defined "amount" (#54). */
export function totalOf(transaction: Transaction): number {
  return transaction.splits.reduce((sum, split) => sum + split.amountCents, 0);
}

/** A transaction as `computeAccountBalance` reads it (#702): its date in the workspace's zone, its total and whether it is pending. */
export function balanceRowOf(transaction: Transaction): BalanceRow {
  return { date: transaction.budgetDate, amountCents: totalOf(transaction), pending: transaction.status === "pending" };
}
