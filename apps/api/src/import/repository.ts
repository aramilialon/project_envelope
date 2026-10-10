/**
 * Import staging (design.md, "Import and reconciliation"): a saved CSV
 * column mapping per account, and the staging area a parsed file's rows land
 * in before they become real transactions.
 */

import {
  detectDuplicates,
  isValidationError,
  parseCamt053,
  parseCsv,
  parseOfx,
  parseQif,
  sumCents,
  type CsvMapping,
  type ExistingTransaction,
  type ImportedTransaction,
  type ImportRow,
  type QifHints,
} from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { createTransaction, createTransfer, listTransactionsForAccount, updateTransaction } from "../transactions/repository.ts";

const STAGING_EXPIRY_INTERVAL = "7 days";

export async function getImportMapping(db: DbPool | DbClient, workspaceId: string, accountId: string): Promise<CsvMapping | undefined> {
  const { rows } = await db.query<{ mapping: CsvMapping }>(
    "SELECT mapping FROM import_mappings WHERE workspace_id = $1 AND account_id = $2",
    [workspaceId, accountId],
  );
  return rows[0]?.mapping;
}

export async function saveImportMapping(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  mapping: CsvMapping,
): Promise<CsvMapping> {
  await db.query(
    `INSERT INTO import_mappings (account_id, workspace_id, mapping)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET mapping = $3, updated_at = now()`,
    [accountId, workspaceId, JSON.stringify(mapping)],
  );
  return mapping;
}

export interface StagedTransactionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly amountCents: number;
  /** The source format's own transaction id, when it carries one (OFX's FITID, #29). */
  readonly externalId: string | null;
  /** Set when duplicate detection matched this row against a transaction already in the account. */
  readonly duplicateOf: string | null;
  readonly createdAt: string;
}

interface StagedTransactionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  /** Read as text (`to_char`, below), not `node-postgres`'s own `date` parsing: that reads a `date` value as midnight in the server process's own time zone, not UTC (#278). */
  readonly occurred_at: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly amount_cents: string;
  readonly external_id: string | null;
  readonly duplicate_of: string | null;
  readonly created_at: Date;
}

const STAGED_COLUMNS =
  "id, workspace_id, account_id, to_char(occurred_at, 'YYYY-MM-DD') AS occurred_at, payee, memo, amount_cents, external_id, duplicate_of, created_at";

function toStagedRecord(row: StagedTransactionRow): StagedTransactionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    occurredAt: row.occurred_at,
    payee: row.payee,
    memo: row.memo,
    amountCents: Number(row.amount_cents),
    externalId: row.external_id,
    duplicateOf: row.duplicate_of,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ClosingBalanceComparison {
  readonly statementCents: number;
  /** The account's current balance plus this import's non-duplicate rows. */
  readonly projectedCents: number;
  readonly differenceCents: number;
}

export interface StageImportResult {
  readonly staged: readonly StagedTransactionRecord[];
  readonly duplicateCount: number;
  readonly closingBalance?: ClosingBalanceComparison;
}

/**
 * Stages already-parsed rows (from any import source), matching each one
 * against the account's existing transactions (`detectDuplicates`, #27) so a
 * matched row is confirmed as clearing that transaction instead of creating
 * a new one. The source file itself is never stored (design.md: "The file
 * is read to extract its rows and is not stored").
 */
async function stageParsedRows(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  parsedRows: readonly ImportRow[],
  closingBalanceCents?: number,
): Promise<StageImportResult> {
  const existingTransactions = await listTransactionsForAccount(db, workspaceId, accountId);
  const existing: ExistingTransaction[] = existingTransactions.map((t) => ({
    id: t.id,
    date: t.budgetDate,
    amount: sumCents(t.splits.map((s) => s.amountCents)),
    ...(t.externalId ? { externalId: t.externalId } : {}),
  }));
  const incoming: ImportedTransaction[] = parsedRows.map((r) => ({
    date: r.date,
    amount: r.amountCents,
    ...(r.externalId ? { externalId: r.externalId } : {}),
  }));
  const matches = detectDuplicates(incoming, existing);
  const duplicateOfByIndex = new Map(matches.map((m) => [m.incomingIndex, m.existingId]));

  const staged: StagedTransactionRecord[] = [];
  for (const [index, row] of parsedRows.entries()) {
    const { rows } = await db.query<StagedTransactionRow>(
      `INSERT INTO staged_transactions (workspace_id, account_id, occurred_at, payee, memo, amount_cents, external_id, duplicate_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${STAGED_COLUMNS}`,
      [
        workspaceId,
        accountId,
        row.date,
        row.payee || null,
        row.memo ?? null,
        row.amountCents,
        row.externalId ?? null,
        duplicateOfByIndex.get(index) ?? null,
      ],
    );
    const inserted = rows[0];
    if (!inserted) {
      throw new Error("stageParsedRows: INSERT ... RETURNING produced no row");
    }
    staged.push(toStagedRecord(inserted));
  }

  const currentBalanceCents = sumCents(existing.map((e) => e.amount));
  const newRowsCents = sumCents(parsedRows.filter((_, index) => !duplicateOfByIndex.has(index)).map((r) => r.amountCents));
  const projectedCents = currentBalanceCents + newRowsCents;

  return {
    staged,
    duplicateCount: matches.length,
    ...(closingBalanceCents !== undefined
      ? { closingBalance: { statementCents: closingBalanceCents, projectedCents, differenceCents: closingBalanceCents - projectedCents } }
      : {}),
  };
}

export async function stageCsvImport(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  csvContent: string,
  mapping: CsvMapping,
  closingBalanceCents?: number,
): Promise<StageImportResult> {
  return stageParsedRows(db, workspaceId, accountId, parseCsv(csvContent, mapping), closingBalanceCents);
}

/** OFX is self-describing (design.md): no column mapping, unlike CSV. */
export async function stageOfxImport(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  ofxContent: string,
  closingBalanceCents?: number,
): Promise<StageImportResult> {
  return stageParsedRows(db, workspaceId, accountId, parseOfx(ofxContent), closingBalanceCents);
}

/**
 * QIF is self-describing too, but its date order and decimal separator are
 * not standardized: `parseQif` infers them from the file's own data, or
 * throws an "ambiguous_date_format"/"ambiguous_decimal_separator"
 * `ValidationError` asking for an explicit hint in `hints` (#30).
 */
export async function stageQifImport(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  qifContent: string,
  hints: QifHints = {},
  closingBalanceCents?: number,
): Promise<StageImportResult> {
  return stageParsedRows(db, workspaceId, accountId, parseQif(qifContent, hints), closingBalanceCents);
}

/** CAMT.053 is self-describing too, and has no date/decimal ambiguity to resolve, unlike QIF (#31). */
export async function stageCamt053Import(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  camt053Content: string,
  closingBalanceCents?: number,
): Promise<StageImportResult> {
  return stageParsedRows(db, workspaceId, accountId, parseCamt053(camt053Content), closingBalanceCents);
}

/** Sweeps rows past the 7-day expiry (design.md) before listing what remains — no queue dependency, since the queue module (0.1.6) does not exist yet. */
export async function listStagedTransactions(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
): Promise<StagedTransactionRecord[]> {
  await db.query(`DELETE FROM staged_transactions WHERE workspace_id = $1 AND created_at < now() - interval '${STAGING_EXPIRY_INTERVAL}'`, [
    workspaceId,
  ]);
  const { rows } = await db.query<StagedTransactionRow>(
    `SELECT ${STAGED_COLUMNS} FROM staged_transactions WHERE workspace_id = $1 AND account_id = $2 ORDER BY occurred_at, created_at`,
    [workspaceId, accountId],
  );
  return rows.map(toStagedRecord);
}

export type StagedTransactionDecision =
  | { readonly stagedTransactionId: string; readonly kind: "income" }
  | { readonly stagedTransactionId: string; readonly kind: "category"; readonly categoryId: string }
  | {
      readonly stagedTransactionId: string;
      readonly kind: "transfer";
      readonly otherAccountId: string;
      /** Required, and applied to the on-budget leg, when `staged.accountId` and `otherAccountId` disagree on on-budget status (#378, #379). */
      readonly categoryId?: string;
    }
  /** A row named in the confirmation with no category, transfer or income recognition — blocks only that row (design.md, #28's own acceptance criteria). */
  | { readonly stagedTransactionId: string; readonly kind: "invalid" };

export type ConfirmationOutcome =
  | { readonly stagedTransactionId: string; readonly outcome: "confirmed"; readonly transactionId: string }
  | { readonly stagedTransactionId: string; readonly outcome: "duplicate_cleared"; readonly transactionId: string }
  | { readonly stagedTransactionId: string; readonly outcome: "rejected"; readonly code: string }
  | { readonly stagedTransactionId: string; readonly outcome: "not_found" };

/**
 * Confirms each decision independently: one row failing (an unsupported
 * transfer, a zero-or-negative amount) is reported as "rejected" and leaves
 * that row staged for a retry, rather than aborting the rest of the batch
 * (design.md: only a row *included in the confirmation* needs a category,
 * transfer or income recognition — the others are unaffected).
 */
export async function confirmStagedTransactions(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  decisions: readonly StagedTransactionDecision[],
): Promise<ConfirmationOutcome[]> {
  const outcomes: ConfirmationOutcome[] = [];
  for (const decision of decisions) {
    const { rows } = await db.query<StagedTransactionRow>(
      `SELECT ${STAGED_COLUMNS} FROM staged_transactions WHERE id = $1 AND workspace_id = $2 AND account_id = $3`,
      [decision.stagedTransactionId, workspaceId, accountId],
    );
    const row = rows[0];
    if (!row) {
      outcomes.push({ stagedTransactionId: decision.stagedTransactionId, outcome: "not_found" });
      continue;
    }
    const staged = toStagedRecord(row);

    if (staged.duplicateOf) {
      // Flagging it in the confirmation is enough (design.md): the existing transaction already has a
      // category, so this row needs no category/transfer/income recognition of its own.
      // Already reconciled or already cleared: still a resolved duplicate, nothing more to change.
      await updateTransaction(db, workspaceId, staged.duplicateOf, { status: "cleared" });
      await db.query("DELETE FROM staged_transactions WHERE id = $1", [staged.id]);
      outcomes.push({ stagedTransactionId: staged.id, outcome: "duplicate_cleared", transactionId: staged.duplicateOf });
      continue;
    }

    if (decision.kind === "invalid") {
      outcomes.push({ stagedTransactionId: staged.id, outcome: "rejected", code: "missing_categorization" });
      continue;
    }

    try {
      const transactionId = await confirmAsNewTransaction(db, workspaceId, staged, decision);
      await db.query("DELETE FROM staged_transactions WHERE id = $1", [staged.id]);
      outcomes.push({ stagedTransactionId: staged.id, outcome: "confirmed", transactionId });
    } catch (error) {
      if (!isValidationError(error)) {
        throw error;
      }
      outcomes.push({ stagedTransactionId: staged.id, outcome: "rejected", code: error.code });
    }
  }
  return outcomes;
}

async function confirmAsNewTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  staged: StagedTransactionRecord,
  decision: StagedTransactionDecision,
): Promise<string> {
  if (decision.kind === "transfer") {
    const isOutflow = staged.amountCents < 0;
    const transfer = await createTransfer(db, {
      workspaceId,
      sourceAccountId: isOutflow ? staged.accountId : decision.otherAccountId,
      destinationAccountId: isOutflow ? decision.otherAccountId : staged.accountId,
      occurredAt: staged.occurredAt,
      amountCents: Math.abs(staged.amountCents),
      status: "cleared",
      ...(staged.payee ? { payee: staged.payee } : {}),
      ...(staged.memo ? { memo: staged.memo } : {}),
      ...(decision.categoryId !== undefined ? { categoryId: decision.categoryId } : {}),
    });
    return transfer.source.accountId === staged.accountId ? transfer.source.id : transfer.destination.id;
  }

  const categoryId = decision.kind === "category" ? decision.categoryId : null;
  const transaction = await createTransaction(db, {
    workspaceId,
    accountId: staged.accountId,
    occurredAt: staged.occurredAt,
    status: "cleared",
    ...(staged.payee ? { payee: staged.payee } : {}),
    ...(staged.memo ? { memo: staged.memo } : {}),
    ...(staged.externalId ? { externalId: staged.externalId } : {}),
    splits: [{ categoryId, amountCents: staged.amountCents }],
  });
  return transaction.id;
}
