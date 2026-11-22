import { assertAmount, assertDate, monthOf, ValidationError } from "@envelope/core";

import { checkAccountsOpen } from "../accounts/open-accounts.ts";
import { recordAuditLog } from "../audit-log/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { isUuid } from "../ids.ts";
import type { QueueDriver } from "../queue/index.ts";
import { BUDGET_RECOMPUTE_JOB, type BudgetRecomputeJobData } from "../queue/job-types.ts";
import { buildMultiRowValues, groupSplitsByParent, validateSplitTotals, type SplitRowLike } from "./splits.ts";

/**
 * Queued in the same transaction as the write that triggers it (design.md, "Notifications";
 * #35), so it is never lost: "when a change reaches the server, a job that recomputes the
 * affected categories is queued." Deduplicated per workspace and month, so a burst of writes
 * (a transfer's two legs, several transactions in one import) collapses into one pending job
 * instead of piling up — the "exclusive" queue policy (#34) already rejects the repeats.
 * Processing this job (recomputing categories, notifying members, #40) reads `queue.work`'s
 * own registration in main.ts; this only queues it. `queue` is optional so every caller that
 * has no use for it (most tests) is unaffected.
 */
async function enqueueBudgetRecompute(
  queue: QueueDriver | undefined,
  db: DbPool | DbClient,
  record: TransactionRecord,
): Promise<void> {
  if (!queue) {
    return;
  }
  const month = monthOf(record.budgetDate);
  await queue.enqueue<BudgetRecomputeJobData>(
    BUDGET_RECOMPUTE_JOB,
    { workspaceId: record.workspaceId, transactionId: record.id, month },
    { deduplicationKey: `${BUDGET_RECOMPUTE_JOB}:${record.workspaceId}:${month}` },
    // Only meaningful when `db` is actually the caller's own request-scoped transaction client,
    // which it always is at every call site that also supplies a `queue` (routes/transactions.ts).
    db as DbClient,
  );
}

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
  /**
   * The account of a transfer's other leg (`transferId`'s own account), or null when this is not a
   * transfer leg. Read, never written: it lets a client name where a transfer goes or comes from,
   * and tell whether that account is off budget (#599), without fetching the other leg.
   */
  readonly transferAccountId: string | null;
  /** The bank's own transaction id, kept from a confirmed import row that carried one (OFX's FITID, #29), for a later re-import's duplicate detection. */
  readonly externalId: string | null;
  /**
   * The trade this transaction is the cash leg of (ADR 0012), or null. A trade-owned transaction's
   * amount, account and date belong to the trade: its splits cannot be replaced and it cannot be
   * deleted through this module (`trade_owned`); its payee, memo and status stay its own.
   */
  readonly tradeId: string | null;
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
  readonly externalId?: string;
}

export interface UpdateTransactionInput {
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  readonly splits?: readonly SplitInput[];
  /**
   * With `splits`, a cross-check of their total. Alone, the new amount of a transaction that has
   * one split (#655): that split is rewritten in place, keeping its category and memo.
   */
  readonly amountCents?: number;
  /**
   * A new date, "YYYY-MM-DD" (#655): midnight of it in the workspace's time zone, as on create.
   * Both legs of a transfer move together.
   */
  readonly occurredAt?: string;
}

const TRANSACTION_COLUMNS = `
  t.id, t.workspace_id, t.account_id, t.occurred_at,
  to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS budget_date,
  t.payee, t.memo, t.status, t.transfer_id, t.external_id, t.trade_id, t.created_at,
  (SELECT partner.account_id FROM transactions partner
    WHERE partner.id = t.transfer_id AND partner.workspace_id = t.workspace_id) AS transfer_account_id
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
  readonly transfer_account_id: string | null;
  readonly external_id: string | null;
  readonly trade_id: string | null;
  readonly created_at: Date;
}

/**
 * Validates a transaction's splits before anything is written — mirroring
 * `packages/core`'s own `aggregateTransactions` checks, so a bad request
 * never reaches a half-written row. Reuses `ValidationError` and its codes
 * directly: whoever maps core's own errors to HTTP responses (`toErrorResponse`)
 * handles these identically, since they are the same kind of problem.
 */
function validateSplits(splits: readonly SplitInput[], expectedTotal: number | undefined): void {
  validateSplitTotals(splits, expectedTotal, "a transaction needs at least one split");
}

/**
 * Refuses income (a single split with no category, not a transfer leg) on an on-budget credit
 * card (#548). `packages/core` does not model income on a card yet (its README, "Known
 * limitations"; design.md, "Credit cards"), and its `aggregateTransactions` throws
 * `unsupported_transaction` for such a row, so one stored row would make every budget-month read
 * of the workspace fail. Refused here, before anything is written, on every path that stores a
 * transaction or a scheduled one: whatever the sign, since the core refuses both. A categorized
 * inflow on a card (a merchant refund) is not income and stays allowed; so does income on an
 * off-budget card, which the budget ignores. Shared with `scheduled-transactions/repository.ts`.
 *
 * @throws ValidationError with code "card_income_not_supported" and `details.accountId`.
 */
export async function assertNotCardIncome(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  splits: readonly { readonly categoryId: string | null }[],
): Promise<void> {
  if (splits.length !== 1 || splits[0]?.categoryId !== null || !isUuid(accountId)) {
    return;
  }
  const { rows } = await db.query<{ type: string; on_budget: boolean }>(
    "SELECT type, on_budget FROM accounts WHERE id = $1 AND workspace_id = $2",
    [accountId, workspaceId],
  );
  const account = rows[0];
  if (account?.type === "credit_card" && account.on_budget) {
    throw new ValidationError("card_income_not_supported", "income on an on-budget credit card is not supported yet", { accountId });
  }
}

/** An instant with its own explicit offset ("Z" or "+02:00") needs no anchoring: it already names one exact moment. */
const HAS_EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

interface InsertTransactionRowInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly status: TransactionStatus;
  readonly externalId: string | null;
  readonly tradeId?: string;
}

/**
 * Inserts a bare `transactions` row (no splits) and returns its id. Shared by
 * `createTransaction` and `createTransfer`'s two linked legs.
 */
async function insertTransactionRow(db: DbPool | DbClient, input: InsertTransactionRowInput): Promise<string> {
  // design.md, "Accounting rules": a date-only occurredAt (a bank import's date, or a plain
  // "YYYY-MM-DD" from a form) is midnight in the WORKSPACE's own time zone, not UTC or
  // whatever zone this database connection happens to default to — Postgres would otherwise
  // silently anchor a naive timestamp to its own session time zone.
  const anchored = HAS_EXPLICIT_OFFSET.test(input.occurredAt);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (workspace_id, account_id, occurred_at, payee, memo, status, external_id, trade_id)
     VALUES (
       $1, $2,
       CASE WHEN $7 THEN $3::timestamptz
            ELSE $3::timestamp AT TIME ZONE (SELECT time_zone FROM workspaces WHERE id = $1)
       END,
       $4, $5, $6, $8, $9
     )
     RETURNING id`,
    [
      input.workspaceId,
      input.accountId,
      input.occurredAt,
      input.payee,
      input.memo,
      input.status,
      anchored,
      input.externalId,
      input.tradeId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("insertTransactionRow: INSERT ... RETURNING produced no row");
  }
  return row.id;
}

export async function createTransaction(
  db: DbPool | DbClient,
  input: CreateTransactionInput,
  queue?: QueueDriver,
): Promise<TransactionRecord> {
  validateSplits(input.splits, input.amountCents);
  await assertNotCardIncome(db, input.workspaceId, input.accountId, input.splits);

  const id = await insertTransactionRow(db, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    occurredAt: input.occurredAt,
    payee: input.payee ?? null,
    memo: input.memo ?? null,
    status: input.status ?? "pending",
    externalId: input.externalId ?? null,
  });
  await insertSplits(db, input.workspaceId, id, input.splits);

  const record = await getTransaction(db, input.workspaceId, id);
  if (!record) {
    throw new Error("createTransaction: the transaction just inserted was not found");
  }
  await enqueueBudgetRecompute(queue, db, record);
  return record;
}

export interface CreateTradeCashLegInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly tradeId: string;
  /** The trade date, "YYYY-MM-DD": the leg is dated at midnight of it in the workspace's time zone. */
  readonly tradeDate: string;
  /** `@envelope/core`'s `tradeCashCents` of the trade: positive is cash into the account. */
  readonly amountCents: number;
}

/**
 * Writes a trade's cash leg (ADR 0012): one transaction on the trade's account, `pending` like any
 * new transaction (the user clears it once it appears on the broker's statement, after
 * settlement), with one split and no category, linked to the trade through `trade_id`. The caller
 * writes it in the same database transaction as the trade.
 */
export async function createTradeCashLeg(db: DbPool | DbClient, input: CreateTradeCashLegInput): Promise<string> {
  assertAmount(input.amountCents, "cash");
  const id = await insertTransactionRow(db, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    occurredAt: input.tradeDate,
    payee: null,
    memo: null,
    status: "pending",
    externalId: null,
    tradeId: input.tradeId,
  });
  await insertSplits(db, input.workspaceId, id, [{ categoryId: null, amountCents: input.amountCents }]);
  return id;
}

export interface RewriteTradeCashLegInput extends CreateTradeCashLegInput {
  /**
   * The account the trade was on before the change, when the caller knows it: the leg itself has
   * already followed the trade there (`ON UPDATE CASCADE`), so only this tells a move apart.
   */
  readonly previousAccountId?: string;
}

/**
 * Brings a trade's cash leg in line with the trade as it now stands (ADR 0012, #509): creates it
 * when the trade moves cash and has none, deletes it when the trade no longer moves any, and
 * otherwise rewrites its amount (its one split), account and date, keeping its id, payee and memo.
 * A `cleared` leg whose amount, account or date changes goes back to `pending`: it no longer
 * matches what was ticked against the statement. A leg left unchanged keeps its status. The date
 * is midnight of the trade date in the workspace's time zone as it is now: after a time zone
 * change, the next rewrite dates the leg again, which counts as a change. The
 * account already follows the trade through the foreign key's `ON UPDATE CASCADE` (migration
 * 0031), so the caller passes the account the leg was on before (`previousAccountId`); it is
 * written here too so the leg is right whatever the caller did first. The caller has already
 * refused a reconciled leg, and writes this in the same database transaction as the trade.
 *
 * @returns the leg's id, or null when the trade moves no cash.
 */
export async function rewriteTradeCashLeg(db: DbPool | DbClient, input: RewriteTradeCashLegInput): Promise<string | null> {
  assertAmount(input.amountCents, "cash");
  const { rows } = await db.query<{ id: string; account_id: string; unchanged_date: boolean; amount_cents: string; status: string }>(
    `SELECT t.id, t.account_id, t.status,
            t.occurred_at = $3::date::timestamp AT TIME ZONE (SELECT time_zone FROM workspaces WHERE id = $1) AS unchanged_date,
            (SELECT sum(amount_cents) FROM splits WHERE transaction_id = t.id) AS amount_cents
     FROM transactions t WHERE t.workspace_id = $1 AND t.trade_id = $2`,
    [input.workspaceId, input.tradeId, input.tradeDate],
  );
  const leg = rows[0];
  const existing = leg?.id;
  if (input.amountCents === 0) {
    if (existing !== undefined) {
      await db.query("DELETE FROM transactions WHERE id = $1 AND workspace_id = $2", [existing, input.workspaceId]);
    }
    return null;
  }
  if (leg === undefined || existing === undefined) {
    return await createTradeCashLeg(db, input);
  }
  const changed =
    (input.previousAccountId ?? leg.account_id) !== input.accountId || !leg.unchanged_date || Number(leg.amount_cents) !== input.amountCents;
  const status = changed && leg.status === "cleared" ? "pending" : leg.status;
  await db.query(
    `UPDATE transactions
     SET account_id = $3,
         occurred_at = $4::date::timestamp AT TIME ZONE (SELECT time_zone FROM workspaces WHERE id = $2),
         status = $5
     WHERE id = $1 AND workspace_id = $2`,
    [existing, input.workspaceId, input.accountId, input.tradeDate, status],
  );
  await db.query("UPDATE splits SET amount_cents = $1 WHERE transaction_id = $2 AND workspace_id = $3", [
    input.amountCents,
    existing,
    input.workspaceId,
  ]);
  return existing;
}

export interface CreateTransferInput {
  readonly workspaceId: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly occurredAt: string;
  /** Positive: the amount moved from the source account to the destination. */
  readonly amountCents: number;
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  /**
   * Applied to whichever leg is on-budget when exactly one of the two accounts is off-budget —
   * money is leaving (or entering) the budget, the same as ordinary spending or income:
   * - on-budget to off-budget: required (design.md, "Account register": "transfers to an
   *   off-budget account ask for a category"), as `packages/core` requires for an outflow;
   * - off-budget to on-budget: optional (#598). Left out, the incoming leg is stored without a
   *   category and is income to assign ("Unassigned"); given, it is that category's activity
   *   (for example refilling the envelope that funded the investment). Left out on a transfer
   *   into an on-budget credit card, it is refused (`card_income_not_supported`), since income
   *   on a card is not modeled yet (#548).
   * Ignored when both accounts are on-budget or both are off-budget, where a transfer is
   * budget-neutral (or entirely outside the budget) either way.
   */
  readonly categoryId?: string;
}

export interface TransferRecord {
  readonly source: TransactionRecord;
  readonly destination: TransactionRecord;
}

/**
 * Creates a transfer as two linked `transactions` rows (`transfer_id`), each with a single
 * split. Both legs are categoryless (the transfer amount itself, not income — income is the
 * only meaning `null` gets on a non-transfer transaction; see `SplitInput`) unless exactly one
 * account is off-budget, in which case the on-budget leg carries `input.categoryId` instead
 * (`CreateTransferInput.categoryId`). The one exception: the on-budget leg of a transfer from an
 * off-budget account into a cash account, left without a category, is income to assign (#598);
 * `packages/core` reads it so from the leg's sign and the other account. A transfer into an
 * on-budget card without a category is refused with `card_income_not_supported` and
 * `details.accountId`; one from an on-budget account to an off-budget one without a category with
 * `uncategorized_transaction`. A transfer between accounts in different currencies is refused with
 * `currency_mismatch` (`details`: `sourceCurrency`, `destinationCurrency`; #652): there are no
 * exchange rates, and one amount cannot mean the same money in two currencies.
 * Card-to-card is a card-to-card transfer (#260), moving money between the two cards' payment
 * categories once the budget month is computed, same as any other transfer here.
 */
export async function createTransfer(db: DbPool | DbClient, input: CreateTransferInput, queue?: QueueDriver): Promise<TransferRecord> {
  assertAmount(input.amountCents);
  if (input.amountCents <= 0) {
    throw new ValidationError("invalid_amount", "a transfer amount must be positive", { amount: input.amountCents });
  }
  if (input.sourceAccountId === input.destinationAccountId) {
    throw new ValidationError("duplicate_account", "a transfer needs two different accounts", {
      accountId: input.sourceAccountId,
    });
  }

  // A malformed id names no account: answered like any other unknown one, not as a database error (#512).
  const malformed = [input.sourceAccountId, input.destinationAccountId].find((id) => !isUuid(id));
  if (malformed !== undefined) {
    throw new ValidationError("unknown_account", `unknown account: "${malformed}"`, { accountId: malformed });
  }
  const { rows } = await db.query<{ id: string; on_budget: boolean; type: string; currency: string }>(
    "SELECT id, on_budget, type, currency FROM accounts WHERE workspace_id = $1 AND id = ANY($2)",
    [input.workspaceId, [input.sourceAccountId, input.destinationAccountId]],
  );
  const accountById = new Map(rows.map((row) => [row.id, row]));
  const source = accountById.get(input.sourceAccountId);
  const destination = accountById.get(input.destinationAccountId);
  if (source === undefined || destination === undefined) {
    const missing = source === undefined ? input.sourceAccountId : input.destinationAccountId;
    throw new ValidationError("unknown_account", `unknown account: "${missing}"`, { accountId: missing });
  }
  // One amount lands in both accounts: with no exchange rates, both must be in the same currency (#652).
  if (source.currency !== destination.currency) {
    throw new ValidationError("currency_mismatch", "a transfer moves money between two accounts in the same currency", {
      sourceCurrency: source.currency,
      destinationCurrency: destination.currency,
    });
  }

  let sourceCategoryId: string | null = null;
  let destinationCategoryId: string | null = null;
  if (source.on_budget && !destination.on_budget) {
    // Money leaving the budget needs a real category (#378), as `packages/core` requires.
    if (input.categoryId === undefined) {
      throw new ValidationError(
        "uncategorized_transaction",
        "a transfer from an on-budget to an off-budget account needs a category on its on-budget leg",
      );
    }
    sourceCategoryId = input.categoryId;
  } else if (!source.on_budget && destination.on_budget) {
    // Money coming into the budget is income to assign when no category is given (#598), except on
    // a credit card, where `packages/core` does not model income yet (#548).
    if (input.categoryId === undefined && destination.type === "credit_card") {
      throw new ValidationError("card_income_not_supported", "income on an on-budget credit card is not supported yet", {
        accountId: destination.id,
      });
    }
    destinationCategoryId = input.categoryId ?? null;
  }

  const sourceId = await insertTransferLeg(db, input, input.sourceAccountId, -input.amountCents, sourceCategoryId);
  const destinationId = await insertTransferLeg(db, input, input.destinationAccountId, input.amountCents, destinationCategoryId);
  await db.query("UPDATE transactions SET transfer_id = $1 WHERE id = $2 AND workspace_id = $3", [
    destinationId,
    sourceId,
    input.workspaceId,
  ]);
  await db.query("UPDATE transactions SET transfer_id = $1 WHERE id = $2 AND workspace_id = $3", [
    sourceId,
    destinationId,
    input.workspaceId,
  ]);

  const sourceRecord = await getTransaction(db, input.workspaceId, sourceId);
  const destinationRecord = await getTransaction(db, input.workspaceId, destinationId);
  if (!sourceRecord || !destinationRecord) {
    throw new Error("createTransfer: a leg just inserted was not found");
  }
  await enqueueBudgetRecompute(queue, db, sourceRecord);
  await enqueueBudgetRecompute(queue, db, destinationRecord);
  return { source: sourceRecord, destination: destinationRecord };
}

async function insertTransferLeg(
  db: DbPool | DbClient,
  input: CreateTransferInput,
  accountId: string,
  signedAmountCents: number,
  categoryId: string | null,
): Promise<string> {
  const id = await insertTransactionRow(db, {
    workspaceId: input.workspaceId,
    accountId,
    occurredAt: input.occurredAt,
    payee: input.payee ?? null,
    memo: input.memo ?? null,
    status: input.status ?? "pending",
    externalId: null,
  });
  await insertSplits(db, input.workspaceId, id, [{ categoryId, amountCents: signedAmountCents }]);
  return id;
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

/** Every transaction of the workspace, across every account — what the budget month endpoint (#16) aggregates. */
export async function listTransactionsForWorkspace(db: DbPool | DbClient, workspaceId: string): Promise<TransactionRecord[]> {
  const { rows } = await db.query<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM transactions t
     JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.workspace_id = $1
     ORDER BY t.occurred_at, t.created_at`,
    [workspaceId],
  );
  const splitsByTransaction = await loadSplits(db, rows.map((r) => r.id));
  return rows.map((row) => toTransactionRecord(row, splitsByTransaction.get(row.id) ?? []));
}

/** One event per split — a split transaction (or a transfer's own leg, `categoryId` null either way) is as many events as it has splits. */
export interface TransactionEvent {
  readonly date: string;
  readonly amountCents: number;
  readonly payee: string | null;
  readonly categoryId: string | null;
  readonly kind: "recorded" | "pending";
}

interface TransactionEventRow {
  readonly date: string;
  readonly amount_cents: string;
  readonly payee: string | null;
  readonly category_id: string | null;
  readonly status: TransactionStatus;
  readonly transfer_id: string | null;
  readonly payment_category_id: string | null;
  readonly split_count: string;
}

/**
 * A credit card's own "Starting balance" transaction (`accounts/repository.ts`'s
 * `createStartingBalanceTransaction`) is the one and only split of a non-transfer transaction,
 * categorized to that same card's own payment category — the one combination no ordinary
 * transaction produces (spending uses a regular category; a card payment is a transfer with no
 * category at all; a cash account's own income has no payment category to match in the first
 * place, `paymentCategoryId` is `null` for it). Shared by `budget/repository.ts` (excluded from
 * `aggregateTransactions` — `packages/core`'s own docs: it feeds only `owedAsOf`, never
 * `Activity`) and this module's own `listTransactionEventsForMonth` (excluded from the budget
 * month's timeline and "To do" list, #326: it is not something that "happened" in the budget
 * sense, just the card's own balance as of account creation) — one rule, not two copies of it.
 */
export function isStartingBalanceSplit(input: {
  readonly transferId: string | null;
  readonly splitCount: number;
  readonly categoryId: string | null;
  readonly paymentCategoryId: string | null;
}): boolean {
  return input.transferId === null && input.splitCount === 1 && input.paymentCategoryId !== null && input.categoryId === input.paymentCategoryId;
}

/**
 * Every split of every transaction dated in `month` (the budget month's own timeline, #325), on
 * an on-budget account, unless `accountId` narrows it to one specific account (the account
 * register's own timeline, `#337`) — any account, on-budget or not, since that screen is about
 * one account's own activity, not the budget's. `budget_date`'s own month, not `occurred_at`'s (a
 * transaction anchored near midnight can fall in a different calendar month once converted to the
 * workspace's own time zone).
 *
 * A transfer's two legs (`transfer_id`) are two ordinary rows, each with its own single
 * null-category split already signed from that leg's own account (negative leaving the source,
 * positive arriving at the destination) — so filtered to one `accountId`, a transfer already
 * shows up correctly with no special-casing at all.
 *
 * Un-filtered (every account), a transfer between two on-budget cash accounts is invisible on
 * purpose: money only moved from one pot to another, nothing a category or the month's own cash
 * total needs to know about (`@envelope/core`'s own invariant does not move either). A transfer
 * touching an off-budget account or a credit card is not neutral that way — paying a card down,
 * or moving money out of the tracked budget entirely, is a real event — so the on-budget leg of
 * that transfer still shows (the off-budget leg is dropped by the plain `on_budget = true` filter
 * already; the card's own leg is dropped by the same transfer check, symmetrically, since from
 * the card's own side its partner is the on-budget cash account).
 *
 * A credit card's own "Starting balance" split (`isStartingBalanceSplit`) never becomes an event
 * either way (`#326`): it is not something that happened in the budget sense, just the card's own
 * balance as of account creation, so neither the timeline nor the "To do" list should ever draw it
 * as a transaction.
 */
export async function listTransactionEventsForMonth(
  db: DbPool | DbClient,
  workspaceId: string,
  month: string,
  accountId?: string,
): Promise<TransactionEvent[]> {
  const params: unknown[] = [workspaceId, month];
  if (accountId !== undefined) {
    params.push(accountId);
  }
  const { rows } = await db.query<TransactionEventRow>(
    `SELECT
       to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS date,
       s.amount_cents, t.payee, s.category_id, t.status, t.transfer_id, a.payment_category_id,
       (SELECT COUNT(*) FROM splits s2 WHERE s2.transaction_id = t.id) AS split_count
     FROM transactions t
     JOIN workspaces w ON w.id = t.workspace_id
     JOIN accounts a ON a.id = t.account_id
     JOIN splits s ON s.transaction_id = t.id
     LEFT JOIN transactions partner ON partner.id = t.transfer_id
     LEFT JOIN accounts partner_account ON partner_account.id = partner.account_id
     WHERE t.workspace_id = $1
       AND to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM') = $2
       ${
         accountId === undefined
           ? `AND a.on_budget = true
              AND NOT (t.transfer_id IS NOT NULL AND partner_account.on_budget = true AND partner_account.type <> 'credit_card')`
           : "AND t.account_id = $3"
       }
     ORDER BY t.occurred_at, t.created_at`,
    params,
  );
  return rows
    .filter(
      (row) =>
        !isStartingBalanceSplit({
          transferId: row.transfer_id,
          splitCount: Number(row.split_count),
          categoryId: row.category_id,
          paymentCategoryId: row.payment_category_id,
        }),
    )
    .map((row) => ({
      date: row.date,
      amountCents: Number(row.amount_cents),
      payee: row.payee,
      categoryId: row.category_id,
      kind: row.status === "pending" ? "pending" : "recorded",
    }));
}

function sumOfSplits(splits: readonly { readonly amountCents: number }[]): number {
  return splits.reduce((sum, split) => sum + split.amountCents, 0);
}

/**
 * How a transfer leg's category is handled (#552, #598), from where its money goes:
 * - `incoming_cash`: the on-budget leg of a transfer from an off-budget account into a cash
 *   account. A category is kept; none leaves it income to assign ("Unassigned").
 * - `incoming_card`: the same into an on-budget credit card. A category is kept; none is refused
 *   (`card_income_not_supported`), since income on a card is not modeled yet (#548).
 * - `outgoing`: the on-budget leg of a transfer to an off-budget account. A category is kept;
 *   none is refused (`uncategorized_transaction`).
 * - `uncategorized`: any other leg (the off-budget leg, both accounts on-budget, both
 *   off-budget). It never carries a category: one sent is ignored.
 * The direction is the leg's own: `amountCents` is its current amount, whose sign an edit cannot
 * change.
 */
type TransferLegKind = "incoming_cash" | "incoming_card" | "outgoing" | "uncategorized";

async function classifyTransferLeg(
  db: DbPool | DbClient,
  workspaceId: string,
  legId: string,
  partnerId: string,
  amountCents: number,
): Promise<TransferLegKind> {
  const { rows } = await db.query<{ id: string; on_budget: boolean; type: string }>(
    `SELECT t.id, a.on_budget, a.type FROM transactions t
       JOIN accounts a ON a.id = t.account_id AND a.workspace_id = t.workspace_id
      WHERE t.workspace_id = $1 AND t.id = ANY($2)`,
    [workspaceId, [legId, partnerId]],
  );
  const leg = rows.find((row) => row.id === legId);
  const partner = rows.find((row) => row.id === partnerId);
  if (leg?.on_budget !== true || partner?.on_budget !== false) {
    return "uncategorized";
  }
  if (amountCents < 0) {
    return "outgoing";
  }
  return leg.type === "credit_card" ? "incoming_card" : "incoming_cash";
}

/**
 * Updates payee/memo/status and, if given, the date (#655) and the splits: `splits` replaces every
 * split, `amountCents` alone rewrites the one split of a transaction that has one (#655; with
 * several, `amount_needs_splits` and `details.splitCount`: nothing says which split the new amount
 * belongs to). Refuses a reconciled transaction (design.md: "Reconciled transactions cannot be
 * edited or deleted" — unlocking one is #32's own explicit, audited action), and a trade's cash leg
 * whose splits, amount or date the edit would change (`trade_owned`, ADR 0012).
 *
 * `accountId`, when given, is the account the request names: a transaction on another account is
 * `not_found`, as one of another workspace is (#655).
 *
 * A write to a closed account is refused with `AccountClosedError` (409 `account_closed`, #741)
 * before any other check that could fail for another reason: the transaction's own account always
 * (every edit writes its row), and the other leg's account of a transfer when the edit moves that
 * leg's amount or date.
 *
 * A new date is midnight of it in the workspace's time zone, as on create; the budget month the
 * transaction counts in follows from it at read time (`budgetDate`). A transfer's two legs share
 * their date: moving one moves the other, in the same database transaction, and a `cleared` other
 * leg goes back to `pending`, since it no longer matches what was ticked against the statement.
 *
 * A transfer's two legs always cancel out (#547): new splits that change one leg's amount give
 * the other leg the opposite amount, in the same database transaction. The other leg keeps its
 * own split — its id, memo and category, if it has one (the on-budget leg of a transfer to or
 * from an off-budget account) — and its payee and memo; a `cleared` other leg goes back to
 * `pending`, since it no longer matches what was ticked against the statement. Both legs are
 * locked first, so the reconciliation flow cannot reconcile the other one in between.
 *
 * A transfer leg holds exactly one split: new splits for it are refused with a `ValidationError`
 * (`unsupported_transaction`) unless there is one, and (`invalid_amount`) when it would make the
 * leg's amount zero or flip its sign — changing a transfer's direction means deleting and
 * recreating it. The edit is refused as `reconciled` when the other leg is reconciled, as
 * `trade_owned` when it is a trade's cash leg, as for the leg itself, and with
 * `unsupported_transaction` when the other leg has several splits (written before #547) and its
 * amount would change, since nothing says which of them the difference belongs to. Every refusal
 * comes before anything is written. A new split with the same amount (a different category on the
 * leg) leaves the other leg alone. The payee, memo and status the request gives stay the edited
 * leg's own.
 *
 * A leg's category follows `createTransfer` (#552, #598; `classifyTransferLeg`), so no stored leg
 * can make every budget-month read of the workspace fail:
 * - the on-budget leg of a transfer to an off-budget account keeps the category sent, and a new
 *   split without one is refused with `uncategorized_transaction`;
 * - the on-budget leg of a transfer from an off-budget account into a cash account keeps the
 *   category sent, or none: income to assign ("Unassigned");
 * - the same into an on-budget credit card keeps the category sent, and a new split without one
 *   is refused with `card_income_not_supported` and `details.accountId`;
 * - on any other leg (both accounts on-budget, both off-budget, or the off-budget leg) a category
 *   in the new split is ignored and the leg stays categoryless, as creating the transfer ignores
 *   it.
 * A new category with the same amount leaves the other leg, and its status, alone.
 *
 * @throws ValidationError `invalid_date` for an `occurredAt` that is not a real "YYYY-MM-DD" date.
 */
export async function updateTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
  patch: UpdateTransactionInput,
  accountId?: string,
): Promise<TransactionRecord | "not_found" | "reconciled" | "trade_owned"> {
  if (patch.occurredAt !== undefined) {
    assertDate(patch.occurredAt);
  }
  const changesAmountOrDate = patch.splits !== undefined || patch.amountCents !== undefined || patch.occurredAt !== undefined;
  let existing = await getTransaction(db, workspaceId, transactionId);
  if (existing !== undefined && existing.transferId !== null && changesAmountOrDate) {
    // Always in id order, so two edits of the same pair, from either leg, never deadlock.
    await db.query("SELECT id FROM transactions WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE", [
      workspaceId,
      [existing.id, existing.transferId],
    ]);
    existing = await getTransaction(db, workspaceId, transactionId);
  }
  if (!existing || (accountId !== undefined && existing.accountId !== accountId)) {
    return "not_found";
  }

  // `amountCents` alone (#655): the new amount of the transaction's one split.
  const onlySplit = existing.splits.length === 1 ? existing.splits[0] : undefined;
  const amountOnly = patch.splits === undefined && patch.amountCents !== undefined;
  const requestedSplits: readonly SplitInput[] | undefined =
    patch.splits ??
    (amountOnly && onlySplit !== undefined
      ? [{ categoryId: onlySplit.categoryId, amountCents: patch.amountCents!, ...(onlySplit.memo === null ? {} : { memo: onlySplit.memo }) }]
      : undefined);

  // Which rows of the other leg of a transfer this edit writes: its date when it moves, its amount
  // when this leg's total changes. Known before any other check, so that a closed account is
  // refused first (#741).
  const oldTotal = sumOfSplits(existing.splits);
  const newTotal = requestedSplits === undefined ? oldTotal : sumOfSplits(requestedSplits);
  let movesDate = false;
  let movesPartnerDate = false;
  if (patch.occurredAt !== undefined) {
    const { rows } = await db.query<{ id: string; unchanged: boolean }>(
      `SELECT t.id, t.occurred_at = ($3::date::timestamp AT TIME ZONE w.time_zone) AS unchanged
       FROM transactions t JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.workspace_id = $1 AND t.id = ANY($2)`,
      [workspaceId, [existing.id, ...(existing.transferId === null ? [] : [existing.transferId])], patch.occurredAt],
    );
    movesDate = rows.some((row) => row.id === existing.id && !row.unchanged);
    movesPartnerDate = rows.some((row) => row.id === existing.transferId && !row.unchanged);
  }
  const movesPartnerAmount = existing.transferId !== null && requestedSplits !== undefined && newTotal !== oldTotal;
  const writesPartner = existing.transferId !== null && (movesPartnerAmount || movesPartnerDate);
  await checkAccountsOpen(db, workspaceId, [existing.accountId, writesPartner ? (existing.transferAccountId ?? undefined) : undefined]);

  if (existing.status === "reconciled") {
    return "reconciled";
  }
  // A trade's cash leg (ADR 0012): its amount and date come from the trade, so they stay as written.
  if (existing.tradeId !== null && (patch.splits !== undefined || patch.amountCents !== undefined || movesDate)) {
    return "trade_owned";
  }
  if (patch.status === "reconciled") {
    // Reconciled is only ever reached through the dedicated reconciliation flow (#32),
    // which ties the transaction to the reconciliations row that reconciled it.
    throw new ValidationError("direct_reconciliation_not_allowed", "a transaction becomes reconciled only through the reconciliation endpoint");
  }
  if (amountOnly && onlySplit === undefined) {
    throw new ValidationError("amount_needs_splits", "a transaction with several splits takes a new amount only with its splits", {
      splitCount: existing.splits.length,
    });
  }
  if (requestedSplits !== undefined) {
    validateSplits(requestedSplits, patch.amountCents);
    // A transfer leg's own split has no category by design: it is not income.
    if (existing.transferId === null) {
      await assertNotCardIncome(db, workspaceId, existing.accountId, requestedSplits);
    }
  }

  let newSplits = requestedSplits;
  if (requestedSplits !== undefined && existing.transferId !== null) {
    const [legSplit, ...extraSplits] = requestedSplits;
    if (legSplit === undefined || extraSplits.length > 0) {
      throw new ValidationError("unsupported_transaction", "a transfer leg holds exactly one split", {
        transactionId: existing.id,
      });
    }
    // The category rule `createTransfer` applies (#552, #598): only the on-budget leg of a transfer
    // to or from an off-budget account carries a category; going out it needs one, coming in it may
    // be left as income to assign, except on a card. Any other leg has none.
    const kind = await classifyTransferLeg(db, workspaceId, existing.id, existing.transferId, oldTotal);
    if (kind === "uncategorized") {
      newSplits = [{ ...legSplit, categoryId: null }];
    } else if (legSplit.categoryId === null && kind === "outgoing") {
      throw new ValidationError(
        "uncategorized_transaction",
        "a transfer from an on-budget to an off-budget account needs a category on its on-budget leg",
        { transactionId: existing.id },
      );
    } else if (legSplit.categoryId === null && kind === "incoming_card") {
      throw new ValidationError("card_income_not_supported", "income on an on-budget credit card is not supported yet", {
        accountId: existing.accountId,
      });
    }
    // A transfer's direction is set when it is created: changing it means deleting and recreating it.
    if (newTotal === 0 || Math.sign(newTotal) !== Math.sign(oldTotal)) {
      throw new ValidationError("invalid_amount", "a transfer leg keeps its direction and a non-zero amount", {
        amount: newTotal,
      });
    }
  }

  // The other leg of a transfer, when this edit moves its amount (#547) or its date (#655).
  let partnerSplitId: string | undefined;
  let partnerStatus: TransactionStatus | undefined;
  if (writesPartner && existing.transferId !== null) {
    const partner = await getTransaction(db, workspaceId, existing.transferId);
    if (partner) {
      if (partner.status === "reconciled") {
        return "reconciled";
      }
      if (partner.tradeId !== null) {
        return "trade_owned";
      }
      if (movesPartnerAmount) {
        const [partnerOnlySplit, ...others] = partner.splits;
        if (partnerOnlySplit === undefined || others.length > 0) {
          throw new ValidationError("unsupported_transaction", "the other leg of this transfer has several splits; its amount cannot follow", {
            transactionId: partner.id,
          });
        }
        partnerSplitId = partnerOnlySplit.id;
      }
      // A cleared leg whose amount or date moves no longer matches what was ticked against the
      // statement, as with a trade's cash leg (`rewriteTradeCashLeg`): it goes back to pending.
      partnerStatus = partner.status === "cleared" ? "pending" : partner.status;
    }
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
  if (movesDate) {
    await setDate(db, workspaceId, transactionId, patch.occurredAt!);
  }

  if (amountOnly && onlySplit !== undefined) {
    // The one split is rewritten in place: it keeps its id, category and memo.
    await db.query("UPDATE splits SET amount_cents = $1 WHERE id = $2 AND workspace_id = $3", [patch.amountCents, onlySplit.id, workspaceId]);
  } else if (newSplits !== undefined) {
    await db.query("DELETE FROM splits WHERE transaction_id = $1 AND workspace_id = $2", [transactionId, workspaceId]);
    await insertSplits(db, workspaceId, transactionId, newSplits);
  }
  if (partnerStatus !== undefined && existing.transferId !== null) {
    if (partnerSplitId !== undefined) {
      await db.query("UPDATE splits SET amount_cents = $1 WHERE id = $2 AND workspace_id = $3", [-newTotal, partnerSplitId, workspaceId]);
    }
    if (movesPartnerDate) {
      await setDate(db, workspaceId, existing.transferId, patch.occurredAt!);
    }
    await db.query("UPDATE transactions SET status = $1 WHERE id = $2 AND workspace_id = $3", [partnerStatus, existing.transferId, workspaceId]);
  }

  const record = await getTransaction(db, workspaceId, transactionId);
  if (!record) {
    throw new Error("updateTransaction: the transaction just updated was not found");
  }
  return record;
}

/** Dates a transaction at midnight of `date` ("YYYY-MM-DD") in the workspace's time zone, as `insertTransactionRow` does. */
async function setDate(db: DbPool | DbClient, workspaceId: string, transactionId: string, date: string): Promise<void> {
  await db.query(
    `UPDATE transactions
     SET occurred_at = $3::date::timestamp AT TIME ZONE (SELECT time_zone FROM workspaces WHERE id = $2)
     WHERE id = $1 AND workspace_id = $2`,
    [transactionId, workspaceId, date],
  );
}

/**
 * Deletes a transaction outright — splits cascade via their own FK. A transfer's two legs are
 * deleted together, never just one, so neither side is left orphaned with a dangling
 * `transferId` (`#403`). Refuses a reconciled transaction, the same rule `updateTransaction`
 * already follows (design.md: "Reconciled transactions cannot be edited or deleted" — unlocking
 * one is #32's own explicit, audited action) — checked on both legs of a transfer, since one
 * side being reconciled must block deleting the pair even if the other side is not. Recorded in
 * the audit log, the same way unlocking a reconciliation is. Refuses a trade's cash leg
 * (`trade_owned`, ADR 0012): it is deleted with its trade. `accountId`, when given, is the account
 * the request names: a transaction on another account is `not_found` (#655).
 */
export async function deleteTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
  userId: string | null,
  accountId?: string,
): Promise<"deleted" | "not_found" | "reconciled" | "trade_owned"> {
  const existing = await getTransaction(db, workspaceId, transactionId);
  if (!existing || (accountId !== undefined && existing.accountId !== accountId)) {
    return "not_found";
  }
  if (existing.status === "reconciled") {
    return "reconciled";
  }
  // A trade's cash leg goes only with its trade (ADR 0012; deleting the trade cascades to it).
  if (existing.tradeId !== null) {
    return "trade_owned";
  }

  const other = existing.transferId ? await getTransaction(db, workspaceId, existing.transferId) : undefined;
  if (other?.status === "reconciled") {
    return "reconciled";
  }

  const ids = other ? [existing.id, other.id] : [existing.id];
  await db.query("DELETE FROM transactions WHERE id = ANY($1) AND workspace_id = $2", [ids, workspaceId]);

  await recordAuditLog(db, {
    workspaceId,
    userId,
    action: "transaction.delete",
    // A plain object, never a bare array: `pg` serializes a top-level JS array parameter as a
    // Postgres ARRAY literal, not JSON, which a `jsonb` column rejects.
    before: other ? { transaction: existing, transferPartner: other } : { transaction: existing },
    after: null,
  });

  return "deleted";
}

async function insertSplits(
  db: DbPool | DbClient,
  workspaceId: string,
  transactionId: string,
  splits: readonly SplitInput[],
): Promise<void> {
  if (splits.length === 0) {
    return;
  }
  const { sql, params } = buildMultiRowValues(splits, (split) => [
    workspaceId,
    transactionId,
    split.categoryId,
    split.amountCents,
    split.memo ?? null,
  ]);
  await db.query(`INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents, memo) VALUES ${sql}`, params);
}

async function loadSplits(db: DbPool | DbClient, transactionIds: readonly string[]): Promise<Map<string, SplitRecord[]>> {
  if (transactionIds.length === 0) {
    return new Map();
  }
  const { rows } = await db.query<SplitRowLike>(
    "SELECT id, transaction_id AS parent_id, category_id, amount_cents, memo FROM splits WHERE transaction_id = ANY($1) ORDER BY id",
    [transactionIds],
  );
  return groupSplitsByParent<SplitRecord>(rows);
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
    transferAccountId: row.transfer_account_id,
    externalId: row.external_id,
    tradeId: row.trade_id,
    createdAt: row.created_at.toISOString(),
    splits,
  };
}
