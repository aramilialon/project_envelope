/**
 * Reconciliation (design.md, "Import and reconciliation", #32): the user
 * enters a statement's closing balance and date; the cleared balance is the
 * last reconciliation's own statement balance plus the cleared transactions
 * up to that date the user keeps ticked. A zero difference reconciles them;
 * a real difference can be resolved by an adjustment transaction, folded
 * into the same call. Unlocking a reconciled transaction (a separate,
 * audited action) marks the reconciliation it belonged to as broken, so a
 * future attempt no longer trusts it as the account's "last" one.
 */

import { assertCents, assertDate, ValidationError } from "@envelope/core";
import { recordAuditLog } from "../audit-log/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { createTransaction, getTransaction, listTransactionsForAccount, type TransactionRecord } from "../transactions/repository.ts";

export interface ReconciliationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly reconciledAt: string;
  readonly statementBalanceCents: number;
  readonly userId: string | null;
  readonly brokenAt: string | null;
  readonly createdAt: string;
}

interface ReconciliationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly reconciled_at: string;
  readonly statement_balance_cents: string;
  readonly user_id: string | null;
  readonly broken_at: Date | null;
  readonly created_at: Date;
}

const RECONCILIATION_COLUMNS =
  "id, workspace_id, account_id, to_char(reconciled_at, 'YYYY-MM-DD') AS reconciled_at, statement_balance_cents, user_id, broken_at, created_at";

function toReconciliationRecord(row: ReconciliationRow): ReconciliationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    reconciledAt: row.reconciled_at,
    statementBalanceCents: Number(row.statement_balance_cents),
    userId: row.user_id,
    brokenAt: row.broken_at ? row.broken_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CandidateTransaction {
  readonly id: string;
  readonly occurredAt: string;
  readonly payee: string | null;
  readonly amountCents: number;
}

export interface ReconciliationCandidates {
  readonly lastReconciledBalanceCents: number;
  readonly pendingTransactions: readonly CandidateTransaction[];
  readonly clearedTransactions: readonly CandidateTransaction[];
}

function transactionAmountCents(transaction: TransactionRecord): number {
  return transaction.splits.reduce((total, split) => total + split.amountCents, 0);
}

function toCandidate(transaction: TransactionRecord): CandidateTransaction {
  return {
    id: transaction.id,
    occurredAt: transaction.budgetDate,
    payee: transaction.payee,
    amountCents: transactionAmountCents(transaction),
  };
}

async function getLastReconciliation(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
): Promise<ReconciliationRecord | undefined> {
  const { rows } = await db.query<ReconciliationRow>(
    `SELECT ${RECONCILIATION_COLUMNS} FROM reconciliations
     WHERE workspace_id = $1 AND account_id = $2 AND broken_at IS NULL
     ORDER BY reconciled_at DESC, created_at DESC
     LIMIT 1`,
    [workspaceId, accountId],
  );
  return rows[0] ? toReconciliationRecord(rows[0]) : undefined;
}

/** Everything a reconciliation screen needs: what is still pending, what is cleared and tickable up to `asOfDate`, and the balance to build on. */
export async function getReconciliationCandidates(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  asOfDate: string,
): Promise<ReconciliationCandidates> {
  assertDate(asOfDate);
  const transactions = await listTransactionsForAccount(db, workspaceId, accountId);
  const lastReconciliation = await getLastReconciliation(db, workspaceId, accountId);

  return {
    lastReconciledBalanceCents: lastReconciliation?.statementBalanceCents ?? 0,
    pendingTransactions: transactions
      .filter((t) => t.status === "pending" && t.budgetDate <= asOfDate)
      .map(toCandidate),
    clearedTransactions: transactions
      .filter((t) => t.status === "cleared" && t.budgetDate <= asOfDate)
      .map(toCandidate),
  };
}

export interface ReconciliationAdjustment {
  readonly categoryId: string | null;
  readonly memo?: string;
}

export interface ReconcileInput {
  readonly accountId: string;
  readonly date: string;
  readonly statementBalanceCents: number;
  readonly tickedTransactionIds: readonly string[];
  readonly userId: string | null;
  readonly adjustment?: ReconciliationAdjustment;
}

export interface ReconciliationSuggestion {
  readonly transactionId: string;
  readonly kind: "pending" | "unticked";
}

export type ReconcileResult =
  | { readonly outcome: "reconciled"; readonly reconciliation: ReconciliationRecord }
  | { readonly outcome: "difference"; readonly differenceCents: number; readonly suggestion?: ReconciliationSuggestion };

/**
 * @throws ValidationError "unknown_transaction" if a ticked id is not an eligible cleared
 * transaction of this account (cleared, not yet reconciled, dated on or before `date`).
 */
export async function reconcileAccount(db: DbPool | DbClient, workspaceId: string, input: ReconcileInput): Promise<ReconcileResult> {
  assertDate(input.date);
  assertCents(input.statementBalanceCents);

  const transactions = await listTransactionsForAccount(db, workspaceId, input.accountId);
  const eligibleCleared = transactions.filter((t) => t.status === "cleared" && t.budgetDate <= input.date);
  const eligibleClearedIds = new Set(eligibleCleared.map((t) => t.id));

  const unknownTickedId = input.tickedTransactionIds.find((id) => !eligibleClearedIds.has(id));
  if (unknownTickedId) {
    throw new ValidationError("unknown_transaction", `"${unknownTickedId}" is not an eligible cleared transaction of this account`, {
      transactionId: unknownTickedId,
    });
  }

  const lastReconciliation = await getLastReconciliation(db, workspaceId, input.accountId);
  const lastReconciledBalanceCents = lastReconciliation?.statementBalanceCents ?? 0;
  const tickedIds = new Set(input.tickedTransactionIds);
  const tickedTotalCents = eligibleCleared
    .filter((t) => tickedIds.has(t.id))
    .reduce((total, t) => total + transactionAmountCents(t), 0);
  const differenceCents = input.statementBalanceCents - (lastReconciledBalanceCents + tickedTotalCents);

  if (differenceCents === 0) {
    return complete(db, workspaceId, input, Array.from(tickedIds));
  }

  if (input.adjustment) {
    const adjustment = await createTransaction(db, {
      workspaceId,
      accountId: input.accountId,
      occurredAt: input.date,
      status: "cleared",
      ...(input.adjustment.memo ? { memo: input.adjustment.memo } : {}),
      splits: [{ categoryId: input.adjustment.categoryId, amountCents: differenceCents }],
    });
    return complete(db, workspaceId, input, [...tickedIds, adjustment.id]);
  }

  const pendingCandidates = transactions.filter((t) => t.status === "pending" && t.budgetDate <= input.date);
  const unticked = eligibleCleared.filter((t) => !tickedIds.has(t.id));
  const suggestion = findSuggestion(pendingCandidates, unticked, differenceCents, input.date);
  return { outcome: "difference", differenceCents, ...(suggestion ? { suggestion } : {}) };
}

function findSuggestion(
  pending: readonly TransactionRecord[],
  unticked: readonly TransactionRecord[],
  differenceCents: number,
  asOfDate: string,
): ReconciliationSuggestion | undefined {
  const candidates = [
    ...pending.filter((t) => transactionAmountCents(t) === differenceCents).map((t): [TransactionRecord, "pending"] => [t, "pending"]),
    ...unticked.filter((t) => transactionAmountCents(t) === differenceCents).map((t): [TransactionRecord, "unticked"] => [t, "unticked"]),
  ];
  if (candidates.length === 0) {
    return undefined;
  }
  const distance = (t: TransactionRecord): number => Math.abs(new Date(t.budgetDate).getTime() - new Date(asOfDate).getTime());
  const [closest] = candidates.sort((a, b) => distance(a[0]) - distance(b[0]));
  const [transaction, kind] = closest!;
  return { transactionId: transaction.id, kind };
}

async function complete(
  db: DbPool | DbClient,
  workspaceId: string,
  input: ReconcileInput,
  tickedTransactionIds: readonly string[],
): Promise<ReconcileResult> {
  const { rows } = await db.query<ReconciliationRow>(
    `INSERT INTO reconciliations (workspace_id, account_id, reconciled_at, statement_balance_cents, user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${RECONCILIATION_COLUMNS}`,
    [workspaceId, input.accountId, input.date, input.statementBalanceCents, input.userId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("reconcileAccount: INSERT ... RETURNING produced no row");
  }
  const reconciliation = toReconciliationRecord(row);

  for (const transactionId of tickedTransactionIds) {
    await db.query("UPDATE transactions SET status = 'reconciled', reconciliation_id = $1 WHERE id = $2 AND workspace_id = $3", [
      reconciliation.id,
      transactionId,
      workspaceId,
    ]);
  }

  return { outcome: "reconciled", reconciliation };
}

/**
 * Unlocks a reconciled transaction back to `cleared`: a separate, explicit action from
 * ordinary edits, recorded in the audit log, breaking the reconciliation it belonged to.
 */
export async function unlockReconciledTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
  userId: string | null,
): Promise<TransactionRecord | "not_found" | "not_reconciled"> {
  const { rows } = await db.query<{ id: string; status: string; reconciliation_id: string | null }>(
    "SELECT id, status, reconciliation_id FROM transactions WHERE id = $1 AND workspace_id = $2",
    [transactionId, workspaceId],
  );
  const existing = rows[0];
  if (!existing) {
    return "not_found";
  }
  if (existing.status !== "reconciled") {
    return "not_reconciled";
  }

  await db.query("UPDATE transactions SET status = 'cleared' WHERE id = $1 AND workspace_id = $2", [transactionId, workspaceId]);
  if (existing.reconciliation_id) {
    await db.query("UPDATE reconciliations SET broken_at = now() WHERE id = $1 AND workspace_id = $2", [
      existing.reconciliation_id,
      workspaceId,
    ]);
  }
  await recordAuditLog(db, {
    workspaceId,
    userId,
    action: "reconciliation.unlock",
    before: { status: "reconciled" },
    after: { status: "cleared" },
  });

  const record = await getTransaction(db, workspaceId, transactionId);
  if (!record) {
    throw new Error("unlockReconciledTransaction: the transaction just unlocked was not found");
  }
  return record;
}
