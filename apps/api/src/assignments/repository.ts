import { randomUUID } from "node:crypto";

import { assertCents, assertMonth, ValidationError } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

export interface AssignmentEntryInput {
  /** "YYYY-MM". */
  readonly month: string;
  /** Null means unassigned money — the same meaning on both sides (ADR 0008). */
  readonly sourceCategoryId: string | null;
  readonly destinationCategoryId: string | null;
  readonly amountCents: number;
}

export interface AssignmentEntryRecord {
  readonly id: string;
  readonly batchId: string;
  readonly workspaceId: string;
  readonly month: string;
  readonly sourceCategoryId: string | null;
  readonly destinationCategoryId: string | null;
  readonly amountCents: number;
  readonly author: string;
  readonly reverses: string | null;
  readonly createdAt: string;
}

export interface CreateAssignmentBatchInput {
  readonly workspaceId: string;
  readonly author: string;
  readonly entries: readonly AssignmentEntryInput[];
}

interface AssignmentEntryRow {
  readonly id: string;
  readonly batch_id: string;
  readonly workspace_id: string;
  readonly month: string;
  readonly source_category_id: string | null;
  readonly destination_category_id: string | null;
  readonly amount_cents: string;
  readonly author: string;
  readonly reverses: string | null;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly created_at: Date;
}

const ENTRY_COLUMNS = `
  id, batch_id, workspace_id, to_char(month, 'YYYY-MM') AS month,
  source_category_id, destination_category_id, amount_cents, author, reverses, created_at
`;

function toEntryRecord(row: AssignmentEntryRow): AssignmentEntryRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    workspaceId: row.workspace_id,
    month: row.month,
    sourceCategoryId: row.source_category_id,
    destinationCategoryId: row.destination_category_id,
    amountCents: Number(row.amount_cents),
    author: row.author,
    reverses: row.reverses,
    createdAt: row.created_at.toISOString(),
  };
}

function validateEntry(entry: AssignmentEntryInput): void {
  assertMonth(entry.month);
  assertCents(entry.amountCents);
  if (entry.amountCents <= 0) {
    throw new ValidationError("invalid_amount", "an assignment amount must be positive", {
      amount: entry.amountCents,
    });
  }
  if (entry.sourceCategoryId === entry.destinationCategoryId) {
    // Also catches both null: an entry needs at least one real category on one side.
    throw new ValidationError(
      "duplicate_category",
      "an assignment entry needs a source or a destination category, and they must differ",
      entry.sourceCategoryId === null ? {} : { categoryId: entry.sourceCategoryId },
    );
  }
}

/**
 * Inserts one batch of ledger rows sharing one `batch_id` (ADR 0008): a
 * single assign/unassign/move is a batch of one; quick assign (#19) is one
 * row per category, all sharing the same batch, so the whole group undoes
 * together. Assigning more than is available, or more than unassigned money
 * holds, is allowed (design.md, "Assign / Move money": a red warning, not a
 * rejection) — this repository does not compute or check available balances.
 */
export async function createAssignmentBatch(
  db: DbPool | DbClient,
  input: CreateAssignmentBatchInput,
): Promise<AssignmentEntryRecord[]> {
  for (const entry of input.entries) {
    validateEntry(entry);
  }

  const batchId = randomUUID();
  const records: AssignmentEntryRecord[] = [];
  for (const entry of input.entries) {
    const { rows } = await db.query<AssignmentEntryRow>(
      `INSERT INTO assignment_ledger
         (batch_id, workspace_id, month, source_category_id, destination_category_id, amount_cents, author)
       VALUES ($1, $2, ($3 || '-01')::date, $4, $5, $6, $7)
       RETURNING ${ENTRY_COLUMNS}`,
      [
        batchId,
        input.workspaceId,
        entry.month,
        entry.sourceCategoryId,
        entry.destinationCategoryId,
        entry.amountCents,
        input.author,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("createAssignmentBatch: INSERT ... RETURNING produced no row");
    }
    records.push(toEntryRecord(row));
  }
  return records;
}

/**
 * Reverses every row of `rows` that does not already have a reverser, as one
 * new batch: source and destination swapped, same amount, `reverses` set to
 * the row it undoes.
 */
async function reverseRows(
  db: DbPool | DbClient,
  workspaceId: string,
  author: string,
  rows: readonly AssignmentEntryRow[],
): Promise<AssignmentEntryRecord[]> {
  const batchId = randomUUID();
  const records: AssignmentEntryRecord[] = [];
  for (const row of rows) {
    const { rows: inserted } = await db.query<AssignmentEntryRow>(
      `INSERT INTO assignment_ledger
         (batch_id, workspace_id, month, source_category_id, destination_category_id, amount_cents, author, reverses)
       VALUES ($1, $2, ($3 || '-01')::date, $4, $5, $6, $7, $8)
       RETURNING ${ENTRY_COLUMNS}`,
      [batchId, workspaceId, row.month, row.destination_category_id, row.source_category_id, row.amount_cents, author, row.id],
    );
    const reversed = inserted[0];
    if (!reversed) {
      throw new Error("reverseRows: INSERT ... RETURNING produced no row");
    }
    records.push(toEntryRecord(reversed));
  }
  return records;
}

/** Rows of `batchId` (or a single row) that do not already have a reverser. */
async function findUndoneRows(
  db: DbPool | DbClient,
  workspaceId: string,
  where: string,
  params: readonly unknown[],
): Promise<AssignmentEntryRow[]> {
  const { rows } = await db.query<AssignmentEntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM assignment_ledger
     WHERE workspace_id = $1 AND ${where}
       AND NOT EXISTS (SELECT 1 FROM assignment_ledger r WHERE r.reverses = assignment_ledger.id)
     ORDER BY created_at`,
    [workspaceId, ...params],
  );
  return rows;
}

/**
 * Undoes a whole batch: reverses every row of it that is not already
 * reversed (ADR 0008 — a row already undone individually is left alone, so
 * `reverses`'s unique constraint is never asked to reverse the same row
 * twice). `"not_found"` when no row of this workspace has that `batch_id`.
 */
export async function undoAssignmentBatch(
  db: DbPool | DbClient,
  workspaceId: string,
  batchId: string,
  author: string,
): Promise<AssignmentEntryRecord[] | "not_found"> {
  const { rows: anyRow } = await db.query<{ id: string }>(
    "SELECT id FROM assignment_ledger WHERE workspace_id = $1 AND batch_id = $2 LIMIT 1",
    [workspaceId, batchId],
  );
  if (anyRow.length === 0) {
    return "not_found";
  }
  const undone = await findUndoneRows(db, workspaceId, "batch_id = $2", [batchId]);
  return reverseRows(db, workspaceId, author, undone);
}

/**
 * Undoes a single row, including one out of a larger batch: creates a batch
 * of one, exactly like a single assign/unassign/move (ADR 0008).
 */
export async function undoAssignmentEntry(
  db: DbPool | DbClient,
  workspaceId: string,
  entryId: string,
  author: string,
): Promise<AssignmentEntryRecord[] | "not_found" | "already_reversed"> {
  const { rows: anyRow } = await db.query<{ id: string }>(
    "SELECT id FROM assignment_ledger WHERE workspace_id = $1 AND id = $2 LIMIT 1",
    [workspaceId, entryId],
  );
  if (anyRow.length === 0) {
    return "not_found";
  }
  const undone = await findUndoneRows(db, workspaceId, "id = $2", [entryId]);
  if (undone.length === 0) {
    return "already_reversed";
  }
  return reverseRows(db, workspaceId, author, undone);
}

export interface AssignmentTotal {
  readonly categoryId: string;
  /** "YYYY-MM". */
  readonly month: string;
  readonly amountCents: number;
}

/**
 * Derives each category's assigned amount per month from the ledger (ADR
 * 0008): incoming minus outgoing entries. `packages/core`'s `computeBudgetMonth`
 * takes exactly this shape as its `Assignment[]` input; the core itself does
 * not change.
 */
export async function listAssignmentTotals(db: DbPool | DbClient, workspaceId: string): Promise<AssignmentTotal[]> {
  const { rows } = await db.query<{ category_id: string; month: string; net: string }>(
    `SELECT category_id, month, SUM(amount) AS net FROM (
       SELECT destination_category_id AS category_id, to_char(month, 'YYYY-MM') AS month, amount_cents AS amount
       FROM assignment_ledger WHERE workspace_id = $1 AND destination_category_id IS NOT NULL
       UNION ALL
       SELECT source_category_id AS category_id, to_char(month, 'YYYY-MM') AS month, -amount_cents AS amount
       FROM assignment_ledger WHERE workspace_id = $1 AND source_category_id IS NOT NULL
     ) entries
     GROUP BY category_id, month`,
    [workspaceId],
  );
  return rows.map((row) => ({ categoryId: row.category_id, month: row.month, amountCents: Number(row.net) }));
}
