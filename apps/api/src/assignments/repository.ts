import { randomUUID } from "node:crypto";

import { assertAmount, assertMonth, ValidationError } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { IdConflictError } from "../errors.ts";
import { withClaimLockTimeout } from "../idempotency/repository.ts";

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
  /**
   * A batch id the client chose (#559, ADR 0020), already claimed with `claimAssignmentBatch`.
   * Without one, the server makes one and claims it here.
   */
  readonly batchId?: string;
}

export interface AssignmentEntryRow {
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
  assertAmount(entry.amountCents);
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

  if (input.entries.length === 0) {
    return [];
  }

  const batchId = input.batchId ?? (await insertServerBatch(db, input.workspaceId));
  const columnsPerRow = 8;
  const values: unknown[] = [];
  const placeholders = input.entries.map((entry, index) => {
    values.push(batchId, input.workspaceId, entry.month, entry.sourceCategoryId, entry.destinationCategoryId, entry.amountCents, input.author, index);
    const base = index * columnsPerRow;
    return `($${base + 1}, $${base + 2}, ($${base + 3} || '-01')::date, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });

  // A single multi-row INSERT ... RETURNING always returns its rows in the same order as
  // the VALUES list that produced them, so `rows[i]` is `input.entries[i]`'s own ledger row.
  const { rows } = await db.query<AssignmentEntryRow>(
    `INSERT INTO assignment_ledger
       (batch_id, workspace_id, month, source_category_id, destination_category_id, amount_cents, author, batch_position)
     VALUES ${placeholders.join(", ")}
     RETURNING ${ENTRY_COLUMNS}`,
    values,
  );
  return rows.map(toEntryRecord);
}

/** Registers a batch id the server made (migration 0039): every ledger row references its batch. */
async function insertServerBatch(db: DbPool | DbClient, workspaceId: string): Promise<string> {
  const batchId = randomUUID();
  await db.query("INSERT INTO assignment_batches (workspace_id, id) VALUES ($1, $2)", [workspaceId, batchId]);
  return batchId;
}

export type AssignmentBatchClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "replay"; readonly entries: AssignmentEntryRecord[] };

/**
 * Claims a batch id the client chose (#559, ADR 0020). Lock order: a request claims its
 * `Idempotency-Key` first, then this batch, and only then takes any other lock (#704's
 * category-month locks, then transactions `FOR UPDATE` in id order, #554); see
 * idempotency/repository.ts. `requestHash` is the fingerprint of what the batch is for
 * (`valueFingerprint` of the entries, or of the quick assign request, with the author).
 *
 * - `claimed`: the id is new in this workspace; the caller writes the batch's rows under it.
 * - `replay`: the same request already wrote this batch: its rows, in the request's order;
 *   nothing is appended.
 *
 * A request in flight with the same batch id makes this wait until it commits or rolls back.
 *
 * @throws IdConflictError (`details: { field: "batchId", batchId }`) when the id is already used
 *   for another request, by a batch whose id the server made, or by one from before migration 0039.
 * @throws RequestInProgressError when the wait is longer than the claim's lock timeout.
 */
export async function claimAssignmentBatch(
  db: DbClient,
  workspaceId: string,
  batchId: string,
  requestHash: Buffer,
): Promise<AssignmentBatchClaim> {
  return withClaimLockTimeout(db, async () => {
    const inserted = await db.query(
      `INSERT INTO assignment_batches (workspace_id, id, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, id) DO NOTHING
       RETURNING id`,
      [workspaceId, batchId, requestHash],
    );
    if (inserted.rows.length > 0) {
      return { kind: "claimed" } as const;
    }
    // READ COMMITTED: this statement sees the batch the INSERT above waited for, once committed.
    const { rows } = await db.query<{ request_hash: Buffer | null }>(
      "SELECT request_hash FROM assignment_batches WHERE workspace_id = $1 AND id = $2",
      [workspaceId, batchId],
    );
    const stored = rows[0]?.request_hash;
    if (!stored || !stored.equals(requestHash)) {
      throw new IdConflictError("batchId", { batchId });
    }
    const { rows: entries } = await db.query<AssignmentEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM assignment_ledger
       WHERE workspace_id = $1 AND batch_id = $2
       ORDER BY batch_position, created_at, id`,
      [workspaceId, batchId],
    );
    return { kind: "replay", entries: entries.map(toEntryRecord) } as const;
  });
}

/**
 * Reverses every row of `rows` that does not already have a reverser, as one
 * new batch: source and destination swapped, same amount, `reverses` set to
 * the row it undoes.
 *
 * `findUndoneRows`'s own check already keeps a single request from reversing the same row
 * twice, but two offline devices can each queue their own reversal of the same row while
 * neither has seen the other's — the second one to sync still passes that check (its own
 * `SELECT` ran before the first device's `INSERT` committed), and only collides here, on
 * `reverses`'s unique constraint (#43). That collision means "already undone by the other
 * device," not a real error (design.md): this row is dropped from the result silently, and the
 * rest of the batch still reverses normally.
 *
 * Exported, with `findUndoneRows` below, so this exact race can be tested directly and
 * deterministically (call it twice with the same already-fetched row) rather than through two
 * genuinely concurrent requests, whose interleaving a test cannot reliably control (#43).
 */
export async function reverseRows(
  db: DbPool | DbClient,
  workspaceId: string,
  author: string,
  rows: readonly AssignmentEntryRow[],
): Promise<AssignmentEntryRecord[]> {
  if (rows.length === 0) {
    return [];
  }

  const batchId = await insertServerBatch(db, workspaceId);
  const columnsPerRow = 9;
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    values.push(batchId, workspaceId, row.month, row.destination_category_id, row.source_category_id, row.amount_cents, author, row.id, index);
    const base = index * columnsPerRow;
    return `($${base + 1}, $${base + 2}, ($${base + 3} || '-01')::date, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });

  // ON CONFLICT (reverses) DO NOTHING keeps the same race safety the old per-row try/catch
  // gave: a row already reversed by a concurrent device (#43) is silently skipped, the rest of
  // the batch still reverses, and RETURNING reports only the rows actually inserted.
  const { rows: inserted } = await db.query<AssignmentEntryRow>(
    `INSERT INTO assignment_ledger
       (batch_id, workspace_id, month, source_category_id, destination_category_id, amount_cents, author, reverses, batch_position)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (reverses) DO NOTHING
     RETURNING ${ENTRY_COLUMNS}`,
    values,
  );
  return inserted.map(toEntryRecord);
}

/** Rows of `batchId` (or a single row) that do not already have a reverser. */
export async function findUndoneRows(
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
  const reversed = await reverseRows(db, workspaceId, author, undone);
  // The only row this call cared about lost the race to another device between the check
  // above and reverseRows's own INSERT (#43) — the same outcome as having lost it earlier.
  return reversed.length === 0 ? "already_reversed" : reversed;
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
