import type { Transaction } from "./api.ts";

/** A transaction's own total: the sum of its splits, its only defined "amount" (#54). */
export function totalOf(transaction: Transaction): number {
  return transaction.splits.reduce((sum, split) => sum + split.amountCents, 0);
}
