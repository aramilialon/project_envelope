/**
 * Split-handling building blocks shared by transactions/repository.ts and
 * scheduled-transactions/repository.ts: validation of the rules both kinds
 * of split share, building a multi-row INSERT, and grouping fetched rows by
 * their parent. A scheduled split's own extra rules (always positive, never
 * a payment category) are not the same thing a real transaction's split
 * checks, so only the shared half moves here.
 */

import { assertCents, ValidationError } from "@envelope/core";

export interface SplitLike {
  readonly categoryId: string | null;
  readonly amountCents: number;
}

export interface SplitRecordLike {
  readonly id: string;
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo: string | null;
}

/** A split row already fetched from either splits table, with its parent id aliased to `parent_id`. */
export interface SplitRowLike {
  readonly id: string;
  readonly parent_id: string;
  readonly category_id: string | null;
  readonly amount_cents: string;
  readonly memo: string | null;
}

/**
 * Checked for both a real transaction's splits and a scheduled one's: at
 * least one split, every amount a safe integer, a null category (income)
 * never mixed into more than one split, and the splits summing to
 * `expectedTotal` when one is given. `onSplit`, when given, runs for each
 * split right after its amount is checked — the hook a scheduled item's own
 * extra rules (always positive, never a payment category) attach to.
 *
 * @throws ValidationError with code "uncategorized_transaction", "unsupported_transaction" or "split_mismatch".
 */
export function validateSplitTotals<T extends SplitLike>(
  splits: readonly T[],
  expectedTotal: number | undefined,
  emptyMessage: string,
  onSplit?: (split: T) => void,
): void {
  if (splits.length === 0) {
    throw new ValidationError("uncategorized_transaction", emptyMessage);
  }
  let total = 0;
  for (const split of splits) {
    assertCents(split.amountCents);
    onSplit?.(split);
    if (split.categoryId === null && splits.length > 1) {
      throw new ValidationError("unsupported_transaction", "income cannot be part of a split");
    }
    total += split.amountCents;
  }
  if (expectedTotal !== undefined) {
    assertCents(expectedTotal);
    if (expectedTotal !== total) {
      throw new ValidationError("split_mismatch", `splits add up to ${total} instead of ${expectedTotal}`, {
        splitTotal: total,
        amount: expectedTotal,
      });
    }
  }
}

/** Builds a multi-row VALUES clause's placeholders and flat params array from `rows`, one call to `toParams` per row. */
export function buildMultiRowValues<T>(rows: readonly T[], toParams: (row: T) => readonly unknown[]): { sql: string; params: unknown[] } {
  const first = rows[0];
  if (first === undefined) {
    throw new Error("buildMultiRowValues: rows must not be empty");
  }
  const columnsPerRow = toParams(first).length;
  const params: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    params.push(...toParams(row));
    const base = index * columnsPerRow;
    return `(${Array.from({ length: columnsPerRow }, (_, i) => `$${base + i + 1}`).join(", ")})`;
  });
  return { sql: placeholders.join(", "), params };
}

/** Groups already-fetched split rows by their parent id, in the order they were selected. */
export function groupSplitsByParent<R extends SplitRecordLike>(rows: readonly SplitRowLike[]): Map<string, R[]> {
  const byParent = new Map<string, R[]>();
  for (const row of rows) {
    const list = byParent.get(row.parent_id) ?? [];
    list.push({ id: row.id, categoryId: row.category_id, amountCents: Number(row.amount_cents), memo: row.memo } as R);
    byParent.set(row.parent_id, list);
  }
  return byParent;
}
