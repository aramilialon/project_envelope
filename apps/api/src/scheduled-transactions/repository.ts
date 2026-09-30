import { assertCents, assertDate, ValidationError, type ScheduledItem } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

export type RecurUnit = "day" | "month" | "year";
const RECUR_UNITS: readonly RecurUnit[] = ["day", "month", "year"];

/** A scheduled transaction is never income: unlike `SplitInput` on a real transaction, `categoryId` is always required. */
export interface ScheduledSplitInput {
  readonly categoryId: string;
  readonly amountCents: number;
  readonly memo?: string;
}

export interface ScheduledSplitRecord {
  readonly id: string;
  readonly categoryId: string;
  readonly amountCents: number;
  readonly memo: string | null;
}

export interface ScheduledTransactionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly nextDueDate: string;
  readonly recurEvery: number;
  readonly recurUnit: RecurUnit;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly splits: readonly ScheduledSplitRecord[];
}

export interface CreateScheduledTransactionInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly payee?: string;
  readonly memo?: string;
  readonly nextDueDate: string;
  readonly recurEvery: number;
  readonly recurUnit: RecurUnit;
  readonly splits: readonly ScheduledSplitInput[];
  /** Optional cross-check (the sum of `splits` must equal it), mirroring transactions' own `amountCents`. */
  readonly amountCents?: number;
}

export interface UpdateScheduledTransactionInput {
  readonly payee?: string;
  readonly memo?: string;
  readonly nextDueDate?: string;
  readonly recurEvery?: number;
  readonly recurUnit?: RecurUnit;
  readonly splits?: readonly ScheduledSplitInput[];
  readonly amountCents?: number;
}

interface ScheduledTransactionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly next_due_date: string;
  readonly recur_every: number;
  readonly recur_unit: RecurUnit;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ScheduledSplitRow {
  readonly id: string;
  readonly scheduled_transaction_id: string;
  readonly category_id: string;
  readonly amount_cents: string;
  readonly memo: string | null;
}

const SCHEDULED_TRANSACTION_COLUMNS = `
  id, workspace_id, account_id, payee, memo,
  to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
  recur_every, recur_unit, created_at, updated_at
`;

function assertValidRecurrence(recurEvery: number, recurUnit: RecurUnit): void {
  if (!RECUR_UNITS.includes(recurUnit)) {
    throw new ValidationError("invalid_recurrence", `recurUnit must be one of ${RECUR_UNITS.join(", ")}`, { recurUnit });
  }
  if (!Number.isInteger(recurEvery) || recurEvery <= 0) {
    throw new ValidationError("invalid_recurrence", "recurEvery must be a positive integer", {
      recurEvery: String(recurEvery),
    });
  }
}

/**
 * Validates a scheduled transaction's splits, mirroring `transactions/repository.ts`'s own
 * `validateSplits` minus the two things that only make sense for something already recorded:
 * a split is never income here (`categoryId` is always required), and an amount is always
 * positive — a scheduled item only ever reserves money (design.md, "Scheduled transactions";
 * `packages/core`'s `ScheduledItem.amount`). A payment category is rejected too: reserving
 * against a card's own payment category is not a supported combination (core's `computeBudgetMonth`
 * would otherwise reject it at budget-month time as an "unknown category", since scheduled items
 * are only ever validated against the regular category set).
 */
function validateScheduledSplits(
  splits: readonly ScheduledSplitInput[],
  expectedTotal: number | undefined,
  paymentCategoryIds: ReadonlySet<string>,
): void {
  if (splits.length === 0) {
    throw new ValidationError("uncategorized_transaction", "a scheduled transaction needs at least one split");
  }
  let total = 0;
  for (const split of splits) {
    assertCents(split.amountCents);
    if (split.amountCents <= 0) {
      throw new ValidationError("invalid_amount", "a scheduled item's amount must be positive", {
        categoryId: split.categoryId,
      });
    }
    if (paymentCategoryIds.has(split.categoryId)) {
      throw new ValidationError(
        "unsupported_transaction",
        "a scheduled item cannot reserve money in a payment category",
        { categoryId: split.categoryId },
      );
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

async function paymentCategoryIdSet(db: DbPool | DbClient, workspaceId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ payment_category_id: string }>(
    "SELECT payment_category_id FROM accounts WHERE workspace_id = $1 AND payment_category_id IS NOT NULL",
    [workspaceId],
  );
  return new Set(rows.map((r) => r.payment_category_id));
}

export async function createScheduledTransaction(
  db: DbPool | DbClient,
  input: CreateScheduledTransactionInput,
): Promise<ScheduledTransactionRecord> {
  assertDate(input.nextDueDate);
  assertValidRecurrence(input.recurEvery, input.recurUnit);
  const paymentCategoryIds = await paymentCategoryIdSet(db, input.workspaceId);
  validateScheduledSplits(input.splits, input.amountCents, paymentCategoryIds);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO scheduled_transactions (workspace_id, account_id, payee, memo, next_due_date, recur_every, recur_unit)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7)
     RETURNING id`,
    [input.workspaceId, input.accountId, input.payee ?? null, input.memo ?? null, input.nextDueDate, input.recurEvery, input.recurUnit],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("createScheduledTransaction: INSERT ... RETURNING produced no row");
  }
  await insertScheduledSplits(db, input.workspaceId, id, input.splits);

  const record = await getScheduledTransaction(db, input.workspaceId, id);
  if (!record) {
    throw new Error("createScheduledTransaction: the row just inserted was not found");
  }
  return record;
}

export async function listScheduledTransactions(db: DbPool | DbClient, workspaceId: string): Promise<ScheduledTransactionRecord[]> {
  const { rows } = await db.query<ScheduledTransactionRow>(
    `SELECT ${SCHEDULED_TRANSACTION_COLUMNS} FROM scheduled_transactions WHERE workspace_id = $1 ORDER BY next_due_date`,
    [workspaceId],
  );
  const splitsById = await loadScheduledSplits(db, rows.map((r) => r.id));
  return rows.map((row) => toScheduledTransactionRecord(row, splitsById.get(row.id) ?? []));
}

export async function getScheduledTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  id: string,
): Promise<ScheduledTransactionRecord | undefined> {
  const { rows } = await db.query<ScheduledTransactionRow>(
    `SELECT ${SCHEDULED_TRANSACTION_COLUMNS} FROM scheduled_transactions WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const splits = await loadScheduledSplits(db, [row.id]);
  return toScheduledTransactionRecord(row, splits.get(row.id) ?? []);
}

export async function updateScheduledTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  id: string,
  patch: UpdateScheduledTransactionInput,
): Promise<ScheduledTransactionRecord | undefined> {
  const existing = await getScheduledTransaction(db, workspaceId, id);
  if (!existing) {
    return undefined;
  }

  const nextDueDate = patch.nextDueDate ?? existing.nextDueDate;
  const recurEvery = patch.recurEvery ?? existing.recurEvery;
  const recurUnit = patch.recurUnit ?? existing.recurUnit;
  assertDate(nextDueDate);
  assertValidRecurrence(recurEvery, recurUnit);
  if (patch.splits !== undefined) {
    const paymentCategoryIds = await paymentCategoryIdSet(db, workspaceId);
    validateScheduledSplits(patch.splits, patch.amountCents, paymentCategoryIds);
  }

  const payee = patch.payee ?? existing.payee ?? undefined;
  const memo = patch.memo ?? existing.memo ?? undefined;
  await db.query(
    `UPDATE scheduled_transactions
     SET payee = $1, memo = $2, next_due_date = $3::date, recur_every = $4, recur_unit = $5, updated_at = now()
     WHERE id = $6 AND workspace_id = $7`,
    [payee ?? null, memo ?? null, nextDueDate, recurEvery, recurUnit, id, workspaceId],
  );

  if (patch.splits !== undefined) {
    await db.query("DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id = $1 AND workspace_id = $2", [
      id,
      workspaceId,
    ]);
    await insertScheduledSplits(db, workspaceId, id, patch.splits);
  }

  const record = await getScheduledTransaction(db, workspaceId, id);
  if (!record) {
    throw new Error("updateScheduledTransaction: the row just updated was not found");
  }
  return record;
}

/** Returns true if a scheduled transaction was found and removed. */
export async function deleteScheduledTransaction(db: DbPool | DbClient, workspaceId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM scheduled_transactions WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  return (rowCount ?? 0) > 0;
}

/**
 * The month's scheduled items not yet recorded (#22's own acceptance criterion, fed into
 * `packages/core`'s `computeBudgetMonth` by `budget/repository.ts`): one `ScheduledItem` per
 * split whose scheduled transaction is due in exactly that month. Nothing here marks a row
 * "recorded" yet — materialization is a separate, later issue (0.1.5 Queue and notifications) —
 * so every row in the table qualifies as long as its own due date falls in the requested month.
 */
export async function listReservationsForMonth(db: DbPool | DbClient, workspaceId: string, month: string): Promise<ScheduledItem[]> {
  const { rows } = await db.query<{ category_id: string; amount_cents: string }>(
    `SELECT s.category_id, s.amount_cents
     FROM scheduled_transaction_splits s
     JOIN scheduled_transactions t ON t.id = s.scheduled_transaction_id
     WHERE t.workspace_id = $1 AND to_char(t.next_due_date, 'YYYY-MM') = $2`,
    [workspaceId, month],
  );
  return rows.map((row) => ({ categoryId: row.category_id, amount: Number(row.amount_cents) }));
}

async function insertScheduledSplits(
  db: DbPool | DbClient,
  workspaceId: string,
  scheduledTransactionId: string,
  splits: readonly ScheduledSplitInput[],
): Promise<void> {
  for (const split of splits) {
    await db.query(
      `INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, category_id, amount_cents, memo)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, scheduledTransactionId, split.categoryId, split.amountCents, split.memo ?? null],
    );
  }
}

async function loadScheduledSplits(
  db: DbPool | DbClient,
  scheduledTransactionIds: readonly string[],
): Promise<Map<string, ScheduledSplitRecord[]>> {
  const byScheduledTransaction = new Map<string, ScheduledSplitRecord[]>();
  if (scheduledTransactionIds.length === 0) {
    return byScheduledTransaction;
  }
  const { rows } = await db.query<ScheduledSplitRow>(
    "SELECT id, scheduled_transaction_id, category_id, amount_cents, memo FROM scheduled_transaction_splits WHERE scheduled_transaction_id = ANY($1) ORDER BY id",
    [scheduledTransactionIds],
  );
  for (const row of rows) {
    const list = byScheduledTransaction.get(row.scheduled_transaction_id) ?? [];
    list.push({ id: row.id, categoryId: row.category_id, amountCents: Number(row.amount_cents), memo: row.memo });
    byScheduledTransaction.set(row.scheduled_transaction_id, list);
  }
  return byScheduledTransaction;
}

function toScheduledTransactionRecord(row: ScheduledTransactionRow, splits: readonly ScheduledSplitRecord[]): ScheduledTransactionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    payee: row.payee,
    memo: row.memo,
    nextDueDate: row.next_due_date,
    recurEvery: row.recur_every,
    recurUnit: row.recur_unit,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    splits,
  };
}
