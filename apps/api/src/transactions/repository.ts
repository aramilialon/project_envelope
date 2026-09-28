import { assertCents, ValidationError } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

export type TransactionStatus = "pending" | "cleared" | "reconciled";

/** `categoryId: null` means income — the only meaning `null` gets on a non-transfer transaction (design.md, "Import and reconciliation"). */
export interface SplitInput {
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo?: string;
}

export interface SplitRecord {
  readonly id: string;
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo: string | null;
}

export interface TransactionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly occurredAt: string;
  /** `occurred_at` converted to the workspace's own time zone, "YYYY-MM-DD" — what packages/core's BudgetTransaction.date wants. */
  readonly budgetDate: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly status: TransactionStatus;
  readonly transferId: string | null;
  readonly createdAt: string;
  readonly splits: readonly SplitRecord[];
}

export interface CreateTransactionInput {
  readonly workspaceId: string;
  readonly accountId: string;
  /** Any value `timestamptz` accepts; ISO date ("2026-09-15") or a full timestamp. */
  readonly occurredAt: string;
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  readonly splits: readonly SplitInput[];
  /** Optional cross-check (a receipt or statement total): if given, must equal the sum of `splits`. */
  readonly amountCents?: number;
}

export interface UpdateTransactionInput {
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  readonly splits?: readonly SplitInput[];
  readonly amountCents?: number;
}

const TRANSACTION_COLUMNS = `
  t.id, t.workspace_id, t.account_id, t.occurred_at,
  to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS budget_date,
  t.payee, t.memo, t.status, t.transfer_id, t.created_at
`;

interface TransactionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly occurred_at: Date;
  readonly budget_date: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly status: TransactionStatus;
  readonly transfer_id: string | null;
  readonly created_at: Date;
}

interface SplitRow {
  readonly id: string;
  readonly transaction_id: string;
  readonly category_id: string | null;
  readonly amount_cents: string;
  readonly memo: string | null;
}

/**
 * Validates a transaction's splits before anything is written — mirroring
 * `packages/core`'s own `aggregateTransactions` checks, so a bad request
 * never reaches a half-written row. Reuses `ValidationError` and its codes
 * directly: whoever maps core's own errors to HTTP responses (`toErrorResponse`)
 * handles these identically, since they are the same kind of problem.
 */
function validateSplits(splits: readonly SplitInput[], expectedTotal: number | undefined): void {
  if (splits.length === 0) {
    throw new ValidationError("uncategorized_transaction", "a transaction needs at least one split");
  }
  let total = 0;
  for (const split of splits) {
    assertCents(split.amountCents);
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

/** An instant with its own explicit offset ("Z" or "+02:00") needs no anchoring: it already names one exact moment. */
const HAS_EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

export async function createTransaction(db: DbPool | DbClient, input: CreateTransactionInput): Promise<TransactionRecord> {
  validateSplits(input.splits, input.amountCents);

  // design.md, "Accounting rules": a date-only occurredAt (a bank import's date, or a plain
  // "YYYY-MM-DD" from a form) is midnight in the WORKSPACE's own time zone, not UTC or
  // whatever zone this database connection happens to default to — Postgres would otherwise
  // silently anchor a naive timestamp to its own session time zone.
  const anchored = HAS_EXPLICIT_OFFSET.test(input.occurredAt);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (workspace_id, account_id, occurred_at, payee, memo, status)
     VALUES (
       $1, $2,
       CASE WHEN $7 THEN $3::timestamptz
            ELSE $3::timestamp AT TIME ZONE (SELECT time_zone FROM workspaces WHERE id = $1)
       END,
       $4, $5, $6
     )
     RETURNING id`,
    [
      input.workspaceId,
      input.accountId,
      input.occurredAt,
      input.payee ?? null,
      input.memo ?? null,
      input.status ?? "pending",
      anchored,
    ],
  );
  const transaction = rows[0];
  if (!transaction) {
    throw new Error("createTransaction: INSERT ... RETURNING produced no row");
  }

  await insertSplits(db, input.workspaceId, transaction.id, input.splits);

  const record = await getTransaction(db, input.workspaceId, transaction.id);
  if (!record) {
    throw new Error("createTransaction: the transaction just inserted was not found");
  }
  return record;
}

export async function getTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
): Promise<TransactionRecord | undefined> {
  const { rows } = await db.query<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM transactions t
     JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.id = $1 AND t.workspace_id = $2`,
    [transactionId, workspaceId],
  );
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const splits = await loadSplits(db, [row.id]);
  return toTransactionRecord(row, splits.get(row.id) ?? []);
}

export async function listTransactionsForAccount(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
): Promise<TransactionRecord[]> {
  const { rows } = await db.query<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM transactions t
     JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.workspace_id = $1 AND t.account_id = $2
     ORDER BY t.occurred_at, t.created_at`,
    [workspaceId, accountId],
  );
  const splitsByTransaction = await loadSplits(db, rows.map((r) => r.id));
  return rows.map((row) => toTransactionRecord(row, splitsByTransaction.get(row.id) ?? []));
}

/**
 * Updates payee/memo/status and, if given, replaces every split. Refuses a
 * reconciled transaction (design.md: "Reconciled transactions cannot be
 * edited or deleted" — unlocking one is #32's own explicit, audited action).
 */
export async function updateTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
  patch: UpdateTransactionInput,
): Promise<TransactionRecord | "not_found" | "reconciled"> {
  const existing = await getTransaction(db, workspaceId, transactionId);
  if (!existing) {
    return "not_found";
  }
  if (existing.status === "reconciled") {
    return "reconciled";
  }
  if (patch.splits !== undefined) {
    validateSplits(patch.splits, patch.amountCents);
  }

  const payee = patch.payee ?? existing.payee ?? undefined;
  const memo = patch.memo ?? existing.memo ?? undefined;
  const status = patch.status ?? existing.status;
  await db.query("UPDATE transactions SET payee = $1, memo = $2, status = $3 WHERE id = $4 AND workspace_id = $5", [
    payee ?? null,
    memo ?? null,
    status,
    transactionId,
    workspaceId,
  ]);

  if (patch.splits !== undefined) {
    await db.query("DELETE FROM splits WHERE transaction_id = $1 AND workspace_id = $2", [transactionId, workspaceId]);
    await insertSplits(db, workspaceId, transactionId, patch.splits);
  }

  const record = await getTransaction(db, workspaceId, transactionId);
  if (!record) {
    throw new Error("updateTransaction: the transaction just updated was not found");
  }
  return record;
}

async function insertSplits(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
  splits: readonly SplitInput[],
): Promise<void> {
  for (const split of splits) {
    await db.query(
      "INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents, memo) VALUES ($1, $2, $3, $4, $5)",
      [workspaceId, transactionId, split.categoryId, split.amountCents, split.memo ?? null],
    );
  }
}

async function loadSplits(db: DbPool | DbClient, transactionIds: readonly string[]): Promise<Map<string, SplitRecord[]>> {
  const byTransaction = new Map<string, SplitRecord[]>();
  if (transactionIds.length === 0) {
    return byTransaction;
  }
  const { rows } = await db.query<SplitRow>(
    "SELECT id, transaction_id, category_id, amount_cents, memo FROM splits WHERE transaction_id = ANY($1) ORDER BY id",
    [transactionIds],
  );
  for (const row of rows) {
    const list = byTransaction.get(row.transaction_id) ?? [];
    list.push({ id: row.id, categoryId: row.category_id, amountCents: Number(row.amount_cents), memo: row.memo });
    byTransaction.set(row.transaction_id, list);
  }
  return byTransaction;
}

function toTransactionRecord(row: TransactionRow, splits: readonly SplitRecord[]): TransactionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    occurredAt: row.occurred_at.toISOString(),
    budgetDate: row.budget_date,
    payee: row.payee,
    memo: row.memo,
    status: row.status,
    transferId: row.transfer_id,
    createdAt: row.created_at.toISOString(),
    splits,
  };
}
