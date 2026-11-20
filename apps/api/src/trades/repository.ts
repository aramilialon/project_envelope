/**
 * Trades (#77, #509; design.md, "Portfolio module"; ADR 0011 and ADR 0012): create, list, edit and
 * delete.
 *
 * Every write follows the same steps, all in the caller's database transaction:
 * 1. build the rows the request stands for (one trade, the two legs of a transfer, or one split row
 *    per portfolio holding the instrument);
 * 2. check their references (brokerage account, portfolio, instrument in the account's currency)
 *    and `@envelope/core`'s `checkTradeEntry`;
 * 3. replay the workspace's whole history of the instrument, every account, with the new rows
 *    (`validatePositionHistory`), under a lock on (workspace, instrument) so two concurrent requests
 *    cannot each pass on their own and together make a holding negative;
 * 4. only then write the rows, each cash-moving one with its cash leg (ADR 0012), and the audit log.
 *
 * Editing and deleting work on a trade's whole group (both legs of a transfer, every row of a
 * split), refuse a group whose cash leg is reconciled, and replay every instrument they touch the
 * same way, without the old rows and with the new ones.
 *
 * Nothing is written before every check has passed: a request answered with a 400 commits nothing.
 */
import { randomUUID } from "node:crypto";

import {
  amountOf,
  applyTradeChanges,
  checkTradeEntry,
  checkTradeRegime,
  computePositions,
  PRICE_FACTOR_ONE,
  TAX_REGIME_COUNTRY,
  toPriceFactor,
  tradeCashCents,
  validatePositionHistory,
  ValidationError,
  type InstrumentType,
  type PositionTrade,
  type Price,
  type PriceFactor,
  type Quantity,
  type TaxKind,
  type TradeChange,
  type TradeType,
} from "@envelope/core";

import { listTaxRegimes } from "../accounts/tax-regimes.ts";
import { recordAuditLog } from "../audit-log/repository.ts";
import type { DbClient, DbPool } from "../db/pool.ts";
import { createTradeCashLeg, rewriteTradeCashLeg } from "../transactions/repository.ts";

export type { TaxKind, TradeType };

export const TRADE_TYPES: readonly TradeType[] = ["buy", "sell", "dividend", "fee", "tax", "split", "transfer"];
export const TAX_KINDS: readonly TaxKind[] = ["stamp_duty", "managed_result_tax", "gain_tax_adjustment", "other"];

/** A trade as the API returns it: the row, plus its cash leg. */
export interface TradeRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly portfolioId: string;
  readonly instrumentId: string | null;
  readonly type: TradeType;
  /** "YYYY-MM-DD", the trade date on the broker's statement (a split's ex-date). */
  readonly tradeDate: string;
  /** ISO 8601, or null when the time is not known. */
  readonly occurredAt: string | null;
  readonly quantityE8: number;
  readonly priceE6: number;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly transactionTaxCents: number;
  readonly accruedInterestCents: number;
  readonly withholdingForeignCents: number;
  readonly withholdingDomesticCents: number;
  readonly gainTaxCents: number;
  readonly taxKind: TaxKind | null;
  readonly costBasisCents: number | null;
  readonly splitFrom: number | null;
  readonly splitTo: number | null;
  readonly transferTradeId: string | null;
  readonly memo: string | null;
  readonly createdAt: string;
  /** The cash the trade moves on its account (`tradeCashCents`): positive is cash in. */
  readonly cashCents: number;
  /** The trade's cash leg (ADR 0012), or null when it moves no cash. */
  readonly cashTransactionId: string | null;
  /** True once the cash leg is reconciled: the trade can no longer be edited or deleted (#509). */
  readonly locked: boolean;
}

/** The amounts of a trade; a field left out is 0. */
export interface TradeAmountsInput {
  readonly quantityE8?: number;
  readonly priceE6?: number;
  /** On a buy or a sell, defaults to quantity × price × the instrument's price factor. */
  readonly grossCents?: number;
  readonly feesCents?: number;
  readonly transactionTaxCents?: number;
  readonly accruedInterestCents?: number;
  readonly withholdingForeignCents?: number;
  readonly withholdingDomesticCents?: number;
  readonly gainTaxCents?: number;
  readonly taxKind?: TaxKind;
  readonly costBasisCents?: number;
  readonly splitFrom?: number;
  readonly splitTo?: number;
}

interface CommonEntryInput {
  readonly tradeDate: string;
  /** Any ISO 8601 timestamp with `Z` or an offset; orders trades within the trade date. */
  readonly occurredAt?: string;
  readonly memo?: string;
}

/** A buy, a sell, a dividend, a fee or a tax: one row. */
export interface SingleTradeInput extends CommonEntryInput, TradeAmountsInput {
  readonly kind: "single";
  readonly type: Exclude<TradeType, "split" | "transfer">;
  /** A client-generated id; a new one when absent. */
  readonly id?: string;
  readonly accountId: string;
  readonly portfolioId: string;
  /** Null only for a fee or a tax charged on the whole account. */
  readonly instrumentId: string | null;
}

export interface TransferLegInput {
  readonly id?: string;
  readonly accountId: string;
  readonly portfolioId: string;
  readonly feesCents?: number;
  /** Only on the incoming leg of a transfer in from outside the app (no `from`). */
  readonly costBasisCents?: number;
}

/**
 * A transfer of securities: `from` and `to` together are the two linked legs (between two
 * portfolios of one account, or between two accounts); `to` alone is a transfer in from outside the
 * app, `from` alone a transfer out of it.
 */
export interface TransferInput extends CommonEntryInput {
  readonly kind: "transfer";
  readonly instrumentId: string;
  /** The units moved, positive. */
  readonly quantityE8: number;
  readonly from?: TransferLegInput;
  readonly to?: TransferLegInput;
}

/** A split, entered once: one row per portfolio holding the instrument, in every account. */
export interface SplitInput extends CommonEntryInput {
  readonly kind: "split";
  readonly instrumentId: string;
  readonly splitFrom: number;
  readonly splitTo: number;
}

export type TradeEntryInput = SingleTradeInput | TransferInput | SplitInput;

export interface TradeFilter {
  readonly portfolioId?: string;
  readonly accountId?: string;
  readonly instrumentId?: string;
}

/** PostgreSQL's own error codes. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** A client-generated id that is already taken, by this workspace or any other. */
export class TradeIdTakenError extends Error {
  readonly tradeId: string;

  constructor(tradeId: string) {
    super(`trade id already taken: ${tradeId}`);
    this.name = "TradeIdTakenError";
    this.tradeId = tradeId;
  }
}

/**
 * A trade that another request moved to another instrument while this one was taking its locks
 * (#509): nothing is written, and the client can simply retry (409 `concurrent_change`).
 */
export class ConcurrentTradeChangeError extends Error {
  readonly tradeId: string;

  constructor(tradeId: string) {
    super(`trade changed concurrently: ${tradeId}`);
    this.name = "ConcurrentTradeChangeError";
    this.tradeId = tradeId;
  }
}

/** Whether `error` is the portfolio foreign key refusing to delete a portfolio that still has trades. */
export function isPortfolioHasTradesViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === FOREIGN_KEY_VIOLATION && constraint === "trades_portfolio_id_fkey";
}

// --- Reading ---------------------------------------------------------------------------------

const TRADE_COLUMNS = `
  t.id, t.workspace_id, t.account_id, t.portfolio_id, t.instrument_id, t.type,
  to_char(t.trade_date, 'YYYY-MM-DD') AS trade_date, t.occurred_at,
  t.quantity_e8, t.price_e6, t.gross_cents, t.fees_cents, t.transaction_tax_cents,
  t.accrued_interest_cents, t.withholding_foreign_cents, t.withholding_domestic_cents, t.gain_tax_cents,
  t.tax_kind, t.cost_basis_cents, t.split_from, t.split_to, t.transfer_trade_id, t.memo, t.created_at
`;

/**
 * The replay order of `@envelope/core` (ADR 0011): trade date, a split first on its date, time,
 * creation time, id. A trade with no time sorts as midnight UTC of its date, as `toPositionTrade`
 * maps it.
 */
const REPLAY_ORDER = `
  t.trade_date, (t.type <> 'split'), COALESCE(t.occurred_at, t.trade_date::timestamp AT TIME ZONE 'UTC'), t.created_at, t.id
`;

interface TradeRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly portfolio_id: string;
  readonly instrument_id: string | null;
  readonly type: TradeType;
  readonly trade_date: string;
  readonly occurred_at: Date | null;
  /** node-postgres returns a `bigint` as a string. */
  readonly quantity_e8: string;
  readonly price_e6: string;
  readonly gross_cents: string;
  readonly fees_cents: string;
  readonly transaction_tax_cents: string;
  readonly accrued_interest_cents: string;
  readonly withholding_foreign_cents: string;
  readonly withholding_domestic_cents: string;
  readonly gain_tax_cents: string;
  readonly tax_kind: TaxKind | null;
  readonly cost_basis_cents: string | null;
  readonly split_from: string | null;
  readonly split_to: string | null;
  readonly transfer_trade_id: string | null;
  readonly memo: string | null;
  readonly created_at: Date;
}

interface ListedTradeRow extends TradeRow {
  readonly cash_transaction_id: string | null;
  readonly cash_status: string | null;
}

interface ReplayRow extends TradeRow {
  readonly currency: string;
  readonly price_factor_e6: string | null;
}

/** A `bigint` column as an exact number; the CHECKs and the API keep every value in range. */
function toNumber(value: string, column: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`trades.${column} is not a safe integer: ${value}`);
  }
  return number;
}

function toNullableNumber(value: string | null, column: string): number | null {
  return value === null ? null : toNumber(value, column);
}

function toTradeRecord(row: ListedTradeRow): TradeRecord {
  const record = {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    portfolioId: row.portfolio_id,
    instrumentId: row.instrument_id,
    type: row.type,
    tradeDate: row.trade_date,
    occurredAt: row.occurred_at ? row.occurred_at.toISOString() : null,
    quantityE8: toNumber(row.quantity_e8, "quantity_e8"),
    priceE6: toNumber(row.price_e6, "price_e6"),
    grossCents: toNumber(row.gross_cents, "gross_cents"),
    feesCents: toNumber(row.fees_cents, "fees_cents"),
    transactionTaxCents: toNumber(row.transaction_tax_cents, "transaction_tax_cents"),
    accruedInterestCents: toNumber(row.accrued_interest_cents, "accrued_interest_cents"),
    withholdingForeignCents: toNumber(row.withholding_foreign_cents, "withholding_foreign_cents"),
    withholdingDomesticCents: toNumber(row.withholding_domestic_cents, "withholding_domestic_cents"),
    gainTaxCents: toNumber(row.gain_tax_cents, "gain_tax_cents"),
    taxKind: row.tax_kind,
    costBasisCents: toNullableNumber(row.cost_basis_cents, "cost_basis_cents"),
    splitFrom: toNullableNumber(row.split_from, "split_from"),
    splitTo: toNullableNumber(row.split_to, "split_to"),
    transferTradeId: row.transfer_trade_id,
    memo: row.memo,
    createdAt: row.created_at.toISOString(),
  };
  return {
    ...record,
    cashCents: tradeCashCents(record),
    cashTransactionId: row.cash_transaction_id,
    locked: row.cash_status === "reconciled",
  };
}

/**
 * The workspace's trades in the replay order, narrowed by any of portfolio, account and
 * instrument. The ids are compared as given: the route checks they are UUIDs.
 */
export async function listTrades(db: DbClient, workspaceId: string, filter: TradeFilter = {}): Promise<TradeRecord[]> {
  const { rows } = await db.query<ListedTradeRow>(
    `SELECT ${TRADE_COLUMNS}, c.id AS cash_transaction_id, c.status AS cash_status
     FROM trades t
     LEFT JOIN transactions c ON c.workspace_id = t.workspace_id AND c.trade_id = t.id
     WHERE t.workspace_id = $1
       AND ($2::uuid IS NULL OR t.portfolio_id = $2)
       AND ($3::uuid IS NULL OR t.account_id = $3)
       AND ($4::uuid IS NULL OR t.instrument_id = $4)
     ORDER BY ${REPLAY_ORDER}`,
    [workspaceId, filter.portfolioId ?? null, filter.accountId ?? null, filter.instrumentId ?? null],
  );
  return rows.map(toTradeRecord);
}

async function listTradesByIds(db: DbClient, workspaceId: string, ids: readonly string[]): Promise<TradeRecord[]> {
  const { rows } = await db.query<ListedTradeRow>(
    `SELECT ${TRADE_COLUMNS}, c.id AS cash_transaction_id, c.status AS cash_status
     FROM trades t
     LEFT JOIN transactions c ON c.workspace_id = t.workspace_id AND c.trade_id = t.id
     WHERE t.workspace_id = $1 AND t.id = ANY($2)
     ORDER BY ${REPLAY_ORDER}`,
    [workspaceId, ids],
  );
  return rows.map(toTradeRecord);
}

/** Whether any trade is filed under the portfolio: such a portfolio cannot be deleted. */
export async function portfolioHasTrades(db: DbClient, workspaceId: string, portfolioId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM trades WHERE workspace_id = $1 AND portfolio_id = $2 LIMIT 1", [
    workspaceId,
    portfolioId,
  ]);
  return rows.length > 0;
}

/** A trade with no time sorts as midnight UTC of its date, before every trade of that date with one. */
function occurredAtOrMidnight(occurredAt: string | null, tradeDate: string): string {
  return occurredAt ?? `${tradeDate}T00:00:00.000Z`;
}

function toPositionTrade(row: ReplayRow): PositionTrade {
  return {
    id: row.id,
    accountId: row.account_id,
    portfolioId: row.portfolio_id,
    instrumentId: row.instrument_id,
    type: row.type,
    date: row.trade_date,
    occurredAt: occurredAtOrMidnight(row.occurred_at ? row.occurred_at.toISOString() : null, row.trade_date),
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    quantity: toNumber(row.quantity_e8, "quantity_e8") as Quantity,
    price: toNumber(row.price_e6, "price_e6") as Price,
    priceFactor: row.price_factor_e6 === null ? PRICE_FACTOR_ONE : toPriceFactor(Number(row.price_factor_e6)),
    grossCents: toNumber(row.gross_cents, "gross_cents"),
    feesCents: toNumber(row.fees_cents, "fees_cents"),
    transactionTaxCents: toNumber(row.transaction_tax_cents, "transaction_tax_cents"),
    accruedInterestCents: toNumber(row.accrued_interest_cents, "accrued_interest_cents"),
    withholdingForeignCents: toNumber(row.withholding_foreign_cents, "withholding_foreign_cents"),
    withholdingDomesticCents: toNumber(row.withholding_domestic_cents, "withholding_domestic_cents"),
    gainTaxCents: toNumber(row.gain_tax_cents, "gain_tax_cents"),
    taxKind: row.tax_kind,
    costBasisCents: toNullableNumber(row.cost_basis_cents, "cost_basis_cents"),
    splitFrom: toNullableNumber(row.split_from, "split_from"),
    splitTo: toNullableNumber(row.split_to, "split_to"),
    transferTradeId: row.transfer_trade_id,
  };
}

/**
 * The workspace's whole history of one instrument, every account, as `@envelope/core`'s replay
 * takes it: each row with its account's currency and the instrument's price factor.
 */
export async function loadInstrumentHistory(db: DbClient, workspaceId: string, instrumentId: string): Promise<PositionTrade[]> {
  const { rows } = await db.query<ReplayRow>(
    `SELECT ${TRADE_COLUMNS}, a.currency, i.price_factor_e6
     FROM trades t
     JOIN accounts a ON a.workspace_id = t.workspace_id AND a.id = t.account_id
     JOIN instruments i ON i.id = t.instrument_id
     WHERE t.workspace_id = $1 AND t.instrument_id = $2
     ORDER BY ${REPLAY_ORDER}`,
    [workspaceId, instrumentId],
  );
  return rows.map(toPositionTrade);
}

/** Whose positions to replay: one portfolio's, or one account's. */
export type PositionScope = { readonly portfolioId: string } | { readonly accountId: string };

/**
 * Every trade the positions of one portfolio or one account need (#79), as `@envelope/core`'s
 * replay takes them: the workspace's whole history, in every account and portfolio, of each
 * instrument the portfolio or account has a trade of (the cost is per account, and a transfer
 * between two accounts carries it from one to the other), plus the scope's own fees and taxes
 * recorded without an instrument. One statement, so one snapshot; the instruments' histories are
 * read through `trades_workspace_instrument_idx` (`= ANY(ARRAY(...))`), the charges by a second
 * branch. The rows come back in no particular order: `computePositions` sorts them itself.
 */
export async function loadPositionTrades(db: DbClient, workspaceId: string, scope: PositionScope): Promise<PositionTrade[]> {
  const portfolioId = "portfolioId" in scope ? scope.portfolioId : null;
  const accountId = "accountId" in scope ? scope.accountId : null;
  const { rows } = await db.query<ReplayRow>(
    `SELECT ${TRADE_COLUMNS}, a.currency, i.price_factor_e6
     FROM trades t
     JOIN accounts a ON a.workspace_id = t.workspace_id AND a.id = t.account_id
     JOIN instruments i ON i.id = t.instrument_id
     WHERE t.workspace_id = $1
       AND t.instrument_id = ANY(ARRAY(
         SELECT DISTINCT s.instrument_id FROM trades s
         WHERE s.workspace_id = $1 AND s.instrument_id IS NOT NULL
           AND ($2::uuid IS NULL OR s.portfolio_id = $2)
           AND ($3::uuid IS NULL OR s.account_id = $3)
       ))
     UNION ALL
     SELECT ${TRADE_COLUMNS}, a.currency, NULL::bigint AS price_factor_e6
     FROM trades t
     JOIN accounts a ON a.workspace_id = t.workspace_id AND a.id = t.account_id
     WHERE t.workspace_id = $1 AND t.instrument_id IS NULL
       AND ($2::uuid IS NULL OR t.portfolio_id = $2)
       AND ($3::uuid IS NULL OR t.account_id = $3)`,
    [workspaceId, portfolioId, accountId],
  );
  return rows.map(toPositionTrade);
}

// --- Writing ---------------------------------------------------------------------------------

/** One row to insert, every column a type does not use already 0 or null. */
interface NewTradeRow {
  readonly id: string;
  readonly accountId: string;
  readonly portfolioId: string;
  readonly instrumentId: string | null;
  readonly type: TradeType;
  readonly tradeDate: string;
  readonly occurredAt: string | null;
  readonly quantityE8: number;
  readonly priceE6: number;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly transactionTaxCents: number;
  readonly accruedInterestCents: number;
  readonly withholdingForeignCents: number;
  readonly withholdingDomesticCents: number;
  readonly gainTaxCents: number;
  readonly taxKind: TaxKind | null;
  readonly costBasisCents: number | null;
  readonly splitFrom: number | null;
  readonly splitTo: number | null;
  readonly transferTradeId: string | null;
  readonly memo: string | null;
}

interface AccountRef {
  readonly type: string;
  readonly currency: string;
  readonly domesticWithholdingAgent: boolean | null;
}

interface InstrumentRef {
  readonly type: InstrumentType;
  readonly currency: string;
  readonly priceFactor: PriceFactor;
}

function rowFromAmounts(
  base: Pick<NewTradeRow, "id" | "accountId" | "portfolioId" | "instrumentId" | "type" | "tradeDate" | "occurredAt" | "memo">,
  amounts: TradeAmountsInput,
  transferTradeId: string | null = null,
): NewTradeRow {
  return {
    ...base,
    quantityE8: amounts.quantityE8 ?? 0,
    priceE6: amounts.priceE6 ?? 0,
    grossCents: amounts.grossCents ?? 0,
    feesCents: amounts.feesCents ?? 0,
    transactionTaxCents: amounts.transactionTaxCents ?? 0,
    accruedInterestCents: amounts.accruedInterestCents ?? 0,
    withholdingForeignCents: amounts.withholdingForeignCents ?? 0,
    withholdingDomesticCents: amounts.withholdingDomesticCents ?? 0,
    gainTaxCents: amounts.gainTaxCents ?? 0,
    taxKind: amounts.taxKind ?? null,
    costBasisCents: amounts.costBasisCents ?? null,
    splitFrom: amounts.splitFrom ?? null,
    splitTo: amounts.splitTo ?? null,
    transferTradeId,
  };
}

async function loadAccounts(db: DbClient, workspaceId: string, ids: readonly string[]): Promise<Map<string, AccountRef>> {
  const { rows } = await db.query<{ id: string; type: string; currency: string; domestic_withholding_agent: boolean | null }>(
    "SELECT id, type, currency, domestic_withholding_agent FROM accounts WHERE workspace_id = $1 AND id = ANY($2)",
    [workspaceId, ids],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { type: row.type, currency: row.currency, domesticWithholdingAgent: row.domestic_withholding_agent },
    ]),
  );
}

async function loadPortfolioIds(db: DbClient, workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM portfolios WHERE workspace_id = $1 AND id = ANY($2)", [
    workspaceId,
    ids,
  ]);
  return new Set(rows.map((row) => row.id));
}

async function loadInstrument(db: DbClient, instrumentId: string): Promise<InstrumentRef | undefined> {
  const { rows } = await db.query<{ type: InstrumentType; currency: string; price_factor_e6: string }>(
    "SELECT type, currency, price_factor_e6 FROM instruments WHERE id = $1",
    [instrumentId],
  );
  const row = rows[0];
  return row ? { type: row.type, currency: row.currency, priceFactor: toPriceFactor(Number(row.price_factor_e6)) } : undefined;
}

/**
 * Serializes every write to one instrument's history in a workspace until the end of the
 * transaction, so the replay below always sees every committed row.
 */
async function lockInstrumentHistory(db: DbClient, workspaceId: string, instrumentId: string | null): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [historyLockKey(workspaceId, instrumentId)]);
}

/**
 * The text an instrument history's lock is taken on. `workspaceId` is always lower case (the
 * membership preHandler's `extractWorkspaceId`) and so is an instrument id read back from
 * PostgreSQL: one history, one key.
 */
function historyLockKey(workspaceId: string, instrumentId: string | null): string {
  return `trades:${workspaceId}:${instrumentId === null ? "account-charges" : instrumentId.toLowerCase()}`;
}

/** The ids a client generated that are already taken, by any workspace. */
async function checkIdsFree(db: DbClient, workspaceId: string, ids: readonly string[]): Promise<void> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM trades WHERE workspace_id = $1 AND id = ANY($2)", [
    workspaceId,
    ids,
  ]);
  const taken = rows[0];
  if (taken) {
    throw new TradeIdTakenError(taken.id);
  }
}

/**
 * The split rows one split stands for: one per (account, portfolio) holding the instrument at the
 * start of the split's date, that is after every trade of an earlier date.
 *
 * @throws ValidationError "split_without_holdings" when no portfolio holds it then.
 */
function splitRows(input: SplitInput, history: readonly PositionTrade[]): NewTradeRow[] {
  const before = history.filter((trade) => trade.date < input.tradeDate);
  const holdings = computePositions(before).portfolios.filter((position) => position.quantity > 0);
  if (holdings.length === 0) {
    throw new ValidationError(
      "split_without_holdings",
      `no portfolio holds instrument ${input.instrumentId} at the start of ${input.tradeDate}`,
      { instrumentId: input.instrumentId, date: input.tradeDate },
    );
  }
  return holdings.map((holding) =>
    rowFromAmounts(
      {
        id: randomUUID(),
        accountId: holding.accountId,
        portfolioId: holding.portfolioId,
        instrumentId: input.instrumentId,
        type: "split",
        tradeDate: input.tradeDate,
        occurredAt: input.occurredAt ?? null,
        memo: input.memo ?? null,
      },
      { splitFrom: input.splitFrom, splitTo: input.splitTo },
    ),
  );
}

function transferRows(input: TransferInput): NewTradeRow[] {
  if (!input.from && !input.to) {
    throw new ValidationError("invalid_trade", "a transfer needs a from leg, a to leg or both", { field: "from" });
  }
  if (input.quantityE8 <= 0) {
    throw new ValidationError("invalid_trade", "a transfer moves a positive quantity", { field: "quantityE8" });
  }
  if (input.from && input.to && input.from.accountId === input.to.accountId && input.from.portfolioId === input.to.portfolioId) {
    throw new ValidationError("invalid_trade", "a transfer needs two different holdings", { field: "to" });
  }
  const fromId = input.from ? (input.from.id ?? randomUUID()) : null;
  const toId = input.to ? (input.to.id ?? randomUUID()) : null;
  const leg = (legInput: TransferLegInput, id: string, quantityE8: number, otherId: string | null): NewTradeRow =>
    rowFromAmounts(
      {
        id,
        accountId: legInput.accountId,
        portfolioId: legInput.portfolioId,
        instrumentId: input.instrumentId,
        type: "transfer",
        tradeDate: input.tradeDate,
        occurredAt: input.occurredAt ?? null,
        memo: input.memo ?? null,
      },
      {
        quantityE8,
        ...(legInput.feesCents === undefined ? {} : { feesCents: legInput.feesCents }),
        ...(legInput.costBasisCents === undefined ? {} : { costBasisCents: legInput.costBasisCents }),
      },
      otherId,
    );
  const rows: NewTradeRow[] = [];
  if (input.from && fromId) rows.push(leg(input.from, fromId, -input.quantityE8, toId));
  if (input.to && toId) rows.push(leg(input.to, toId, input.quantityE8, fromId));
  return rows;
}

function singleRow(input: SingleTradeInput, instrument: InstrumentRef | undefined): NewTradeRow {
  const row = rowFromAmounts(
    {
      id: input.id ?? randomUUID(),
      accountId: input.accountId,
      portfolioId: input.portfolioId,
      instrumentId: input.instrumentId,
      type: input.type,
      tradeDate: input.tradeDate,
      occurredAt: input.occurredAt ?? null,
      memo: input.memo ?? null,
    },
    input,
  );
  if ((input.type === "buy" || input.type === "sell") && input.grossCents === undefined && instrument) {
    // The amount of the units, rounded once (ADR 0011); the broker's own figure overrides it.
    const grossCents = amountOf(row.quantityE8 as Quantity, row.priceE6 as Price, instrument.priceFactor, instrument.currency);
    return { ...row, grossCents };
  }
  return row;
}

/** Checks every row's account and portfolio, and the instrument against each account. */
async function checkReferences(
  db: DbClient,
  workspaceId: string,
  rows: readonly NewTradeRow[],
  instrument: InstrumentRef | undefined,
): Promise<Map<string, AccountRef>> {
  const accountIds = [...new Set(rows.map((row) => row.accountId))];
  const accounts = await loadAccounts(db, workspaceId, accountIds);
  for (const accountId of accountIds) {
    const account = accounts.get(accountId);
    if (!account) {
      throw new ValidationError("unknown_account", `unknown account: "${accountId}"`, { accountId });
    }
    if (account.type !== "brokerage") {
      throw new ValidationError("account_not_brokerage", "trades are recorded on brokerage accounts only", {
        accountId,
        accountType: account.type,
      });
    }
    // No exchange rates yet (0.2.0): every amount of a trade is in the account's currency, and so
    // is the instrument's price.
    if (instrument && instrument.currency !== account.currency) {
      throw new ValidationError("currency_mismatch", "the instrument's currency differs from the account's", {
        accountId,
        accountCurrency: account.currency,
        instrumentCurrency: instrument.currency,
      });
    }
  }
  const portfolioIds = [...new Set(rows.map((row) => row.portfolioId))];
  const known = await loadPortfolioIds(db, workspaceId, portfolioIds);
  const unknown = portfolioIds.find((id) => !known.has(id));
  if (unknown !== undefined) {
    throw new ValidationError("unknown_portfolio", `unknown portfolio: "${unknown}"`, { portfolioId: unknown });
  }
  return accounts;
}

/** The same ISO 8601 shape `@envelope/core` accepts for a trade's time: `Z` or an offset. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A trade's time only orders trades within its trade date, so it must fall on that date in the
 * workspace's time zone.
 *
 * @throws ValidationError "invalid_trade" (details: field "occurredAt") otherwise, or when it is not
 *   an ISO 8601 timestamp with `Z` or an offset.
 */
function checkOccurredOnTradeDate(row: NewTradeRow, timeZone: string): void {
  if (row.occurredAt === null) {
    return;
  }
  const ms = TIMESTAMP_PATTERN.test(row.occurredAt) ? Date.parse(row.occurredAt) : Number.NaN;
  const localDate = Number.isFinite(ms)
    ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
    : null;
  if (localDate !== row.tradeDate) {
    throw new ValidationError("invalid_trade", `occurredAt ${row.occurredAt} is not on the trade date ${row.tradeDate}`, {
      tradeId: row.id,
      field: "occurredAt",
    });
  }
}

/**
 * The tax regime rules (#508), only in a workspace whose tax country has them (`IT`): every
 * brokerage account there needs a regime history (`tax_regime_required`; its first period also
 * covers earlier dates), and each row is checked against the regime in force on its trade date
 * (`checkTradeRegime`). Elsewhere there is no regime and nothing to check.
 */
async function checkRegimes(
  db: DbClient,
  workspaceId: string,
  taxCountry: string | null,
  rows: readonly NewTradeRow[],
  accounts: ReadonlyMap<string, AccountRef>,
  instrument: InstrumentRef | undefined,
): Promise<void> {
  if (taxCountry !== TAX_REGIME_COUNTRY) {
    return;
  }
  for (const accountId of new Set(rows.map((row) => row.accountId))) {
    const history = (await listTaxRegimes(db, workspaceId, accountId)) ?? [];
    if (history.length === 0) {
      throw new ValidationError("tax_regime_required", "a brokerage account in this workspace needs a tax regime before its trades", {
        accountId,
      });
    }
    for (const row of rows.filter((candidate) => candidate.accountId === accountId)) {
      checkTradeRegime(row, {
        history,
        date: row.tradeDate,
        domesticWithholdingAgent: accounts.get(accountId)!.domesticWithholdingAgent,
        instrumentType: instrument?.type ?? null,
      });
    }
  }
}

/** The current transaction's timestamp, the same `now()` the created_at column defaults to. */
async function transactionTimestamp(db: DbClient): Promise<string> {
  const { rows } = await db.query<{ now: Date }>("SELECT now() AS now");
  return rows[0]!.now.toISOString();
}

/** A row to write as `@envelope/core`'s replay will see it once written, in its account's currency. */
function replayTrade(
  row: NewTradeRow,
  createdAt: string,
  accounts: ReadonlyMap<string, AccountRef>,
  instrument: InstrumentRef | undefined,
): PositionTrade {
  return {
    id: row.id,
    accountId: row.accountId,
    portfolioId: row.portfolioId,
    instrumentId: row.instrumentId,
    type: row.type,
    date: row.tradeDate,
    occurredAt: occurredAtOrMidnight(row.occurredAt, row.tradeDate),
    createdAt,
    currency: accounts.get(row.accountId)!.currency,
    quantity: row.quantityE8 as Quantity,
    price: row.priceE6 as Price,
    priceFactor: instrument?.priceFactor ?? PRICE_FACTOR_ONE,
    grossCents: row.grossCents,
    feesCents: row.feesCents,
    transactionTaxCents: row.transactionTaxCents,
    accruedInterestCents: row.accruedInterestCents,
    withholdingForeignCents: row.withholdingForeignCents,
    withholdingDomesticCents: row.withholdingDomesticCents,
    gainTaxCents: row.gainTaxCents,
    taxKind: row.taxKind,
    costBasisCents: row.costBasisCents,
    splitFrom: row.splitFrom,
    splitTo: row.splitTo,
    transferTradeId: row.transferTradeId,
  };
}

/**
 * Every check of the rows to write that does not need the history: their references, then
 * `checkTradeEntry`, the time on the trade date and, in an `IT` workspace, the tax regime.
 */
async function checkRows(
  db: DbClient,
  workspaceId: string,
  rows: readonly NewTradeRow[],
  instrument: InstrumentRef | undefined,
): Promise<Map<string, AccountRef>> {
  const accounts = await checkReferences(db, workspaceId, rows, instrument);
  for (const row of rows) {
    checkTradeEntry(row, instrument?.type ?? null);
  }
  const { rows: workspaceRows } = await db.query<{ tax_country: string | null; time_zone: string }>(
    "SELECT tax_country, time_zone FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  const workspace = workspaceRows[0]!;
  for (const row of rows) {
    checkOccurredOnTradeDate(row, workspace.time_zone);
  }
  await checkRegimes(db, workspaceId, workspace.tax_country, rows, accounts, instrument);
  return accounts;
}

async function insertTradeRow(db: DbClient, workspaceId: string, row: NewTradeRow): Promise<void> {
  try {
    await db.query(
      `INSERT INTO trades (
         id, workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, occurred_at,
         quantity_e8, price_e6, gross_cents, fees_cents, transaction_tax_cents, accrued_interest_cents,
         withholding_foreign_cents, withholding_domestic_cents, gain_tax_cents, tax_kind, cost_basis_cents,
         split_from, split_to, transfer_trade_id, memo
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        row.id,
        workspaceId,
        row.accountId,
        row.portfolioId,
        row.instrumentId,
        row.type,
        row.tradeDate,
        row.occurredAt,
        row.quantityE8,
        row.priceE6,
        row.grossCents,
        row.feesCents,
        row.transactionTaxCents,
        row.accruedInterestCents,
        row.withholdingForeignCents,
        row.withholdingDomesticCents,
        row.gainTaxCents,
        row.taxKind,
        row.costBasisCents,
        row.splitFrom,
        row.splitTo,
        row.transferTradeId,
        row.memo,
      ],
    );
  } catch (error) {
    // Another workspace's trade with the same client-generated id: invisible to this one, but the
    // primary key is global.
    const { code, constraint } = error as { code?: unknown; constraint?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === "trades_pkey") {
      throw new TradeIdTakenError(row.id);
    }
    throw error;
  }
}

/**
 * Creates the trades one request stands for: a buy, sell, dividend, fee or tax (one row), a
 * transfer (one or two linked legs) or a split (one row per portfolio holding the instrument), each
 * cash-moving row with its cash leg (ADR 0012), and records them in the audit log. `db` must be in
 * a transaction: the request's own.
 *
 * @throws ValidationError "unknown_account", "account_not_brokerage", "unknown_portfolio",
 *   "unknown_instrument", "currency_mismatch", "split_without_holdings", "tax_regime_required",
 *   the codes of `checkTradeEntry`, of `checkTradeRegime` and of `validatePositionHistory` ("insufficient_quantity",
 *   "split_missing_for_portfolio", "split_duplicate", "split_ratio_mismatch",
 *   "split_leaves_no_quantity", "invalid_trade", "invalid_date", "invalid_amount",
 *   "invalid_quantity", "invalid_price"); nothing is written then.
 * @throws TradeIdTakenError when a client-generated id is already taken.
 */
export async function createTrades(
  db: DbClient,
  workspaceId: string,
  userId: string | null,
  input: TradeEntryInput,
): Promise<TradeRecord[]> {
  const instrumentId = input.instrumentId;
  const instrument = instrumentId === null ? undefined : await loadInstrument(db, instrumentId);
  if (instrumentId !== null && !instrument) {
    throw new ValidationError("unknown_instrument", `unknown instrument: "${instrumentId}"`, { instrumentId });
  }

  await lockInstrumentHistory(db, workspaceId, instrumentId);
  const history = instrumentId === null ? [] : await loadInstrumentHistory(db, workspaceId, instrumentId);

  const rows =
    input.kind === "single" ? [singleRow(input, instrument)] : input.kind === "transfer" ? transferRows(input) : splitRows(input, history);
  await checkIdsFree(db, workspaceId, rows.map((row) => row.id));
  const accounts = await checkRows(db, workspaceId, rows, instrument);

  // The rows as the replay sees them once written: created now (the transaction's timestamp, the
  // same `now()` the created_at column defaults to), in the account's currency.
  const createdAt = await transactionTimestamp(db);
  const inserts = rows.map((row) => replayTrade(row, createdAt, accounts, instrument));
  validatePositionHistory(applyTradeChanges(history, inserts.map((trade) => ({ kind: "insert", trade }))));

  // The two legs of a transfer point at each other: the link is checked once both exist.
  const linked = rows.some((row) => row.transferTradeId !== null);
  if (linked) {
    await db.query("SET CONSTRAINTS trades_transfer_trade_id_fkey DEFERRED");
  }
  for (const row of rows) {
    await insertTradeRow(db, workspaceId, row);
    const cashCents = tradeCashCents(row);
    if (cashCents !== 0) {
      await createTradeCashLeg(db, { workspaceId, accountId: row.accountId, tradeId: row.id, tradeDate: row.tradeDate, amountCents: cashCents });
    }
  }
  if (linked) {
    await db.query("SET CONSTRAINTS trades_transfer_trade_id_fkey IMMEDIATE");
  }

  const records = await listTradesByIds(db, workspaceId, rows.map((row) => row.id));
  await recordAuditLog(db, { workspaceId, userId, action: "trade.create", before: null, after: { trades: records } });
  return records;
}

// --- Editing and deleting (#509) --------------------------------------------------------------

/** A change to one leg of a transfer; a field left out keeps its value. */
export interface TransferLegPatch {
  readonly accountId?: string;
  readonly portfolioId?: string;
  readonly feesCents?: number;
  /** Only on the incoming leg of a transfer in from outside the app. */
  readonly costBasisCents?: number;
}

/**
 * An edit of a trade: a field left out keeps its value; `null` clears `occurredAt`, `memo` and,
 * on a fee or a tax, `instrumentId`. Which fields apply depends on the trade's type, which an edit
 * cannot change:
 * - a buy, sell, dividend, fee or tax takes every field of its create request but `id` and `type`;
 *   on a buy or a sell, a `grossCents` left out while the quantity, the price or the instrument
 *   changes is computed again from them, as on create, so the broker's own figure must be sent
 *   again with the edit to keep it;
 * - a transfer takes `instrumentId`, `tradeDate`, `occurredAt`, `memo`, `quantityE8` (the units
 *   moved, positive) and `from`/`to` for the legs it has, and edits both legs together;
 * - a split takes `tradeDate`, `occurredAt`, `memo`, `splitFrom` and `splitTo`, and edits every row
 *   it stands for (`splitRows` on the new date decides which holdings it covers).
 */
export interface TradePatchInput extends TradeAmountsInput {
  /** Accepted only when it names the trade's own type. */
  readonly type?: string;
  readonly accountId?: string;
  readonly portfolioId?: string;
  readonly instrumentId?: string | null;
  readonly tradeDate?: string;
  readonly occurredAt?: string | null;
  readonly memo?: string | null;
  readonly from?: TransferLegPatch;
  readonly to?: TransferLegPatch;
}

const COMMON_PATCH_FIELDS = ["type", "tradeDate", "occurredAt", "memo"] as const;
const PATCH_FIELDS: Readonly<Record<"single" | "transfer" | "split", readonly (keyof TradePatchInput)[]>> = {
  single: [
    ...COMMON_PATCH_FIELDS,
    "accountId",
    "portfolioId",
    "instrumentId",
    "taxKind",
    "quantityE8",
    "priceE6",
    "grossCents",
    "feesCents",
    "transactionTaxCents",
    "accruedInterestCents",
    "withholdingForeignCents",
    "withholdingDomesticCents",
    "gainTaxCents",
    "costBasisCents",
    "splitFrom",
    "splitTo",
  ],
  transfer: [...COMMON_PATCH_FIELDS, "instrumentId", "quantityE8", "from", "to"],
  split: [...COMMON_PATCH_FIELDS, "splitFrom", "splitTo"],
};

function groupKind(type: TradeType): "single" | "transfer" | "split" {
  return type === "transfer" || type === "split" ? type : "single";
}

/**
 * @throws ValidationError "invalid_trade" (details: field) for a field the trade's type does not
 *   take in an edit, or a `type` other than its own.
 */
function checkPatchFields(type: TradeType, patch: TradePatchInput): void {
  if (patch.type !== undefined && patch.type !== type) {
    throw new ValidationError("invalid_trade", "the type of a trade cannot change", { field: "type" });
  }
  const allowed = PATCH_FIELDS[groupKind(type)];
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined && !allowed.includes(field as keyof TradePatchInput)) {
      throw new ValidationError("invalid_trade", `an edit of a ${type} does not take ${field}`, { field });
    }
  }
}

/** The edit's value when it gives one (null included), else the current one. */
function patched<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}

/** A stored trade as a row to write, every column as it is now. */
function rowOf(record: TradeRecord): NewTradeRow {
  return {
    id: record.id,
    accountId: record.accountId,
    portfolioId: record.portfolioId,
    instrumentId: record.instrumentId,
    type: record.type,
    tradeDate: record.tradeDate,
    occurredAt: record.occurredAt,
    quantityE8: record.quantityE8,
    priceE6: record.priceE6,
    grossCents: record.grossCents,
    feesCents: record.feesCents,
    transactionTaxCents: record.transactionTaxCents,
    accruedInterestCents: record.accruedInterestCents,
    withholdingForeignCents: record.withholdingForeignCents,
    withholdingDomesticCents: record.withholdingDomesticCents,
    gainTaxCents: record.gainTaxCents,
    taxKind: record.taxKind,
    costBasisCents: record.costBasisCents,
    splitFrom: record.splitFrom,
    splitTo: record.splitTo,
    transferTradeId: record.transferTradeId,
    memo: record.memo,
  };
}

/** The fields every kind of edit takes, applied to one row. */
function withCommon(row: NewTradeRow, patch: TradePatchInput): NewTradeRow {
  return {
    ...row,
    tradeDate: patch.tradeDate ?? row.tradeDate,
    occurredAt: patched(patch.occurredAt, row.occurredAt),
    memo: patched(patch.memo, row.memo),
  };
}

function editedSingleRow(record: TradeRecord, patch: TradePatchInput, instrument: InstrumentRef | undefined): NewTradeRow {
  const instrumentId = patched(patch.instrumentId, record.instrumentId);
  if (instrumentId === null && record.type !== "fee" && record.type !== "tax") {
    throw new ValidationError("invalid_trade", `a ${record.type} needs an instrument`, { field: "instrumentId" });
  }
  const current = rowOf(record);
  const row: NewTradeRow = {
    ...withCommon(current, patch),
    accountId: patch.accountId ?? current.accountId,
    portfolioId: patch.portfolioId ?? current.portfolioId,
    instrumentId,
    quantityE8: patch.quantityE8 ?? current.quantityE8,
    priceE6: patch.priceE6 ?? current.priceE6,
    grossCents: patch.grossCents ?? current.grossCents,
    feesCents: patch.feesCents ?? current.feesCents,
    transactionTaxCents: patch.transactionTaxCents ?? current.transactionTaxCents,
    accruedInterestCents: patch.accruedInterestCents ?? current.accruedInterestCents,
    withholdingForeignCents: patch.withholdingForeignCents ?? current.withholdingForeignCents,
    withholdingDomesticCents: patch.withholdingDomesticCents ?? current.withholdingDomesticCents,
    gainTaxCents: patch.gainTaxCents ?? current.gainTaxCents,
    taxKind: patch.taxKind ?? current.taxKind,
    costBasisCents: patch.costBasisCents ?? current.costBasisCents,
    splitFrom: patch.splitFrom ?? current.splitFrom,
    splitTo: patch.splitTo ?? current.splitTo,
  };
  const unitsChanged = patch.quantityE8 !== undefined || patch.priceE6 !== undefined || patch.instrumentId !== undefined;
  if ((row.type === "buy" || row.type === "sell") && patch.grossCents === undefined && unitsChanged && instrument) {
    // As on create: the amount of the units, rounded once (ADR 0011), unless the edit gives the
    // broker's own figure.
    const grossCents = amountOf(row.quantityE8 as Quantity, row.priceE6 as Price, instrument.priceFactor, instrument.currency);
    return { ...row, grossCents };
  }
  return row;
}

/** Both legs of a transfer (or its one leg, from or to outside the app) as edited. */
function editedTransferRows(group: readonly TradeRecord[], patch: TradePatchInput): NewTradeRow[] {
  const from = group.find((record) => record.quantityE8 < 0);
  const to = group.find((record) => record.quantityE8 > 0);
  if (patch.from !== undefined && !from) {
    throw new ValidationError("invalid_trade", "this transfer has no outgoing leg", { field: "from" });
  }
  if (patch.to !== undefined && !to) {
    throw new ValidationError("invalid_trade", "this transfer has no incoming leg", { field: "to" });
  }
  const quantityE8 = patch.quantityE8 ?? Math.abs(group[0]!.quantityE8);
  if (quantityE8 <= 0) {
    throw new ValidationError("invalid_trade", "a transfer moves a positive quantity", { field: "quantityE8" });
  }
  if (patch.instrumentId === null) {
    throw new ValidationError("invalid_trade", "a transfer needs an instrument", { field: "instrumentId" });
  }
  const leg = (record: TradeRecord, legPatch: TransferLegPatch | undefined, sign: 1 | -1): NewTradeRow => {
    const current = rowOf(record);
    return {
      ...withCommon(current, patch),
      instrumentId: patch.instrumentId ?? current.instrumentId,
      accountId: legPatch?.accountId ?? current.accountId,
      portfolioId: legPatch?.portfolioId ?? current.portfolioId,
      quantityE8: sign * quantityE8,
      feesCents: legPatch?.feesCents ?? current.feesCents,
      costBasisCents: legPatch?.costBasisCents ?? current.costBasisCents,
    };
  };
  const outgoing = from ? leg(from, patch.from, -1) : undefined;
  const incoming = to ? leg(to, patch.to, 1) : undefined;
  if (outgoing && incoming && outgoing.accountId === incoming.accountId && outgoing.portfolioId === incoming.portfolioId) {
    throw new ValidationError("invalid_trade", "a transfer needs two different holdings", { field: "to" });
  }
  return [outgoing, incoming].filter((row): row is NewTradeRow => row !== undefined);
}

/**
 * The rows of a split as edited: `splitRows` on the new date and ratio, over the history without
 * the split, decides which holdings it covers; a holding it already covered keeps its row's id.
 */
function editedSplitRows(
  group: readonly TradeRecord[],
  patch: TradePatchInput,
  historyWithoutSplit: readonly PositionTrade[],
): NewTradeRow[] {
  const first = group[0]!;
  const occurredAt = patched(patch.occurredAt, first.occurredAt);
  const memo = patched(patch.memo, first.memo);
  const rows = splitRows(
    {
      kind: "split",
      instrumentId: first.instrumentId!,
      tradeDate: patch.tradeDate ?? first.tradeDate,
      splitFrom: patch.splitFrom ?? first.splitFrom!,
      splitTo: patch.splitTo ?? first.splitTo!,
      ...(occurredAt === null ? {} : { occurredAt }),
      ...(memo === null ? {} : { memo }),
    },
    historyWithoutSplit,
  );
  return rows.map((row) => {
    const kept = group.find((record) => record.accountId === row.accountId && record.portfolioId === row.portfolioId);
    return kept ? { ...row, id: kept.id } : row;
  });
}

/**
 * A trade and every row edited or deleted with it: the two legs of a transfer, or every row of a
 * split (the instrument's split rows on that date, in every account). Undefined when the workspace
 * has no trade with this id.
 */
async function loadTradeGroup(db: DbClient, workspaceId: string, tradeId: string): Promise<TradeRecord[] | undefined> {
  const [trade] = await listTradesByIds(db, workspaceId, [tradeId]);
  if (!trade) {
    return undefined;
  }
  if (trade.type === "split") {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM trades WHERE workspace_id = $1 AND type = 'split' AND instrument_id = $2 AND trade_date = $3",
      [workspaceId, trade.instrumentId, trade.tradeDate],
    );
    return await listTradesByIds(db, workspaceId, rows.map((row) => row.id));
  }
  if (trade.transferTradeId !== null) {
    return await listTradesByIds(db, workspaceId, [trade.id, trade.transferTradeId]);
  }
  return [trade];
}

/**
 * Takes the history locks (`lockInstrumentHistory`) of the trade's instrument and of `alsoLock`
 * (the instrument an edit moves it to), always in the same order so two requests cannot wait on
 * each other, and loads the trade's group once they are held: what it returns is what the replay
 * will see.
 */
async function lockTradeGroup(
  db: DbClient,
  workspaceId: string,
  tradeId: string,
  alsoLock: string | null | undefined,
): Promise<TradeRecord[] | undefined> {
  const unlocked = await loadTradeGroup(db, workspaceId, tradeId);
  if (!unlocked) {
    return undefined;
  }
  const keys = new Set<string | null>([unlocked[0]!.instrumentId]);
  if (alsoLock !== undefined) keys.add(alsoLock);
  // Why this cannot deadlock: a request takes every history lock it will ever hold here, at once,
  // in one total order (the lock keys compared as plain strings, `<`, never by locale), and takes
  // no other history lock afterwards; `createTrades` takes a single one. Two requests that want an
  // overlapping set therefore always queue on the lowest key they share, and the one holding it
  // never waits for a key the other holds. Row locks taken later (the cash legs, FOR UPDATE) are
  // only ever taken after the history locks, and a reconciliation that holds a leg never waits
  // for a history lock.
  const ordered = [...keys]
    .map((key) => ({ key, text: historyLockKey(workspaceId, key) }))
    .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  for (const { key } of ordered) {
    await lockInstrumentHistory(db, workspaceId, key);
  }
  const group = await loadTradeGroup(db, workspaceId, tradeId);
  // Moved to another instrument by a request that committed between the first read and the
  // locks: its history is not locked, and locking it now would break the order above. The client
  // retries; the retry reads the new instrument first.
  if (group && !keys.has(group[0]!.instrumentId)) {
    throw new ConcurrentTradeChangeError(tradeId);
  }
  return group;
}

/**
 * Whether any of the trades' cash legs is reconciled, locking the legs until the end of the
 * transaction so a reconciliation cannot take one between this check and the write.
 */
async function anyCashLegReconciled(db: DbClient, workspaceId: string, tradeIds: readonly string[]): Promise<boolean> {
  const { rows } = await db.query<{ status: string }>(
    "SELECT status FROM transactions WHERE workspace_id = $1 AND trade_id = ANY($2) FOR UPDATE",
    [workspaceId, tradeIds],
  );
  return rows.some((row) => row.status === "reconciled");
}

/** Stored trades as the replay sees them, for a group with no instrument (a fee or a tax on the whole account). */
async function loadReplayRowsByIds(db: DbClient, workspaceId: string, ids: readonly string[]): Promise<PositionTrade[]> {
  const { rows } = await db.query<ReplayRow>(
    `SELECT ${TRADE_COLUMNS}, a.currency, i.price_factor_e6
     FROM trades t
     JOIN accounts a ON a.workspace_id = t.workspace_id AND a.id = t.account_id
     LEFT JOIN instruments i ON i.id = t.instrument_id
     WHERE t.workspace_id = $1 AND t.id = ANY($2)
     ORDER BY ${REPLAY_ORDER}`,
    [workspaceId, ids],
  );
  return rows.map(toPositionTrade);
}

async function updateTradeRow(db: DbClient, workspaceId: string, row: NewTradeRow): Promise<void> {
  await db.query(
    `UPDATE trades SET
       account_id = $3, portfolio_id = $4, instrument_id = $5, trade_date = $6, occurred_at = $7,
       quantity_e8 = $8, price_e6 = $9, gross_cents = $10, fees_cents = $11, transaction_tax_cents = $12,
       accrued_interest_cents = $13, withholding_foreign_cents = $14, withholding_domestic_cents = $15,
       gain_tax_cents = $16, tax_kind = $17, cost_basis_cents = $18, split_from = $19, split_to = $20, memo = $21
     WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      row.id,
      row.accountId,
      row.portfolioId,
      row.instrumentId,
      row.tradeDate,
      row.occurredAt,
      row.quantityE8,
      row.priceE6,
      row.grossCents,
      row.feesCents,
      row.transactionTaxCents,
      row.accruedInterestCents,
      row.withholdingForeignCents,
      row.withholdingDomesticCents,
      row.gainTaxCents,
      row.taxKind,
      row.costBasisCents,
      row.splitFrom,
      row.splitTo,
      row.memo,
    ],
  );
}

/**
 * Edits a trade with every row that goes with it (the other leg of a transfer, every row of a
 * split), and rewrites each one's cash leg (`rewriteTradeCashLeg`): created when the trade starts
 * moving cash, deleted when it stops, otherwise its amount, account and date rewritten. Runs the
 * same checks as `createTrades` on the edited rows, then replays the workspace's whole history of
 * every instrument the edit touches (the old one and the new one), every account, under their
 * locks; writes a `trade.update` audit log entry. `db` must be in a transaction: the request's own.
 *
 * @returns the rows as written; "not_found" when the workspace has no trade with this id;
 *   "reconciled" when a cash leg of the group is reconciled (ADR 0012), and nothing is written.
 * @throws ValidationError with `createTrades`'s codes, and "invalid_trade" (details: field) for a
 *   field the trade's type does not take in an edit; nothing is written then.
 * @throws ConcurrentTradeChangeError when another request moved the trade to another instrument
 *   while this one took its locks; nothing is written, and a retry can succeed.
 */
export async function updateTrade(
  db: DbClient,
  workspaceId: string,
  userId: string | null,
  tradeId: string,
  patch: TradePatchInput,
): Promise<TradeRecord[] | "not_found" | "reconciled"> {
  const group = await lockTradeGroup(db, workspaceId, tradeId, patch.instrumentId);
  if (!group) {
    return "not_found";
  }
  const first = group[0]!;
  if (await anyCashLegReconciled(db, workspaceId, group.map((record) => record.id))) {
    return "reconciled";
  }
  checkPatchFields(first.type, patch);

  const instrumentId = patched(patch.instrumentId, first.instrumentId);
  const instrument = instrumentId === null ? undefined : await loadInstrument(db, instrumentId);
  if (instrumentId !== null && !instrument) {
    throw new ValidationError("unknown_instrument", `unknown instrument: "${instrumentId}"`, { instrumentId });
  }

  // The history of every instrument the edit touches, as stored. A group with no instrument (a fee
  // or a tax on the whole account) is its own history.
  const oldIds = new Set(group.map((record) => record.id));
  const histories = new Map<string | null, PositionTrade[]>();
  for (const key of new Set([first.instrumentId, instrumentId])) {
    histories.set(
      key,
      // Only the rows stored with no instrument: a fee whose instrument the edit clears is not in
      // this history yet, it arrives in it (an insert below).
      key === null
        ? await loadReplayRowsByIds(db, workspaceId, group.filter((record) => record.instrumentId === null).map((record) => record.id))
        : await loadInstrumentHistory(db, workspaceId, key),
    );
  }

  const kind = groupKind(first.type);
  const rows =
    kind === "single"
      ? [editedSingleRow(first, patch, instrument)]
      : kind === "transfer"
        ? editedTransferRows(group, patch)
        : editedSplitRows(group, patch, histories.get(instrumentId)!.filter((trade) => !oldIds.has(trade.id)));
  const accounts = await checkRows(db, workspaceId, rows, instrument);

  // Each instrument's history as it would be after the edit: a row that stays on its instrument
  // is an update (keeping its creation time, so its place in the replay order), a row that leaves
  // it a deletion, a row that arrives (another instrument, or a split's new holding) an insert.
  const now = await transactionTimestamp(db);
  for (const [key, history] of histories) {
    const changes: TradeChange[] = [];
    for (const record of group) {
      if (record.instrumentId !== key) continue;
      const row = rows.find((candidate) => candidate.id === record.id);
      changes.push(
        row && row.instrumentId === key
          ? { kind: "update", trade: replayTrade(row, record.createdAt, accounts, instrument) }
          : { kind: "delete", tradeId: record.id },
      );
    }
    for (const row of rows) {
      if (row.instrumentId !== key) continue;
      const stored = group.find((record) => record.id === row.id);
      if (!stored || stored.instrumentId !== key) {
        changes.push({ kind: "insert", trade: replayTrade(row, stored?.createdAt ?? now, accounts, instrument) });
      }
    }
    validatePositionHistory(applyTradeChanges(history, changes));
  }

  const newIds = new Set(rows.map((row) => row.id));
  const removed = group.filter((record) => !newIds.has(record.id)).map((record) => record.id);
  if (removed.length > 0) {
    await db.query("DELETE FROM trades WHERE workspace_id = $1 AND id = ANY($2)", [workspaceId, removed]);
  }
  for (const row of rows) {
    if (oldIds.has(row.id)) {
      await updateTradeRow(db, workspaceId, row);
    } else {
      await insertTradeRow(db, workspaceId, row);
    }
    const previous = group.find((record) => record.id === row.id);
    await rewriteTradeCashLeg(db, {
      workspaceId,
      accountId: row.accountId,
      tradeId: row.id,
      tradeDate: row.tradeDate,
      amountCents: tradeCashCents(row),
      ...(previous ? { previousAccountId: previous.accountId } : {}),
    });
  }

  const records = await listTradesByIds(db, workspaceId, [...newIds]);
  await recordAuditLog(db, { workspaceId, userId, action: "trade.update", before: { trades: group }, after: { trades: records } });
  return records;
}

/**
 * Deletes a trade with every row that goes with it (both legs of a transfer, every row of a split);
 * their cash legs go with them (`ON DELETE CASCADE`, ADR 0012). Replays the workspace's whole
 * history of the instrument without them first, under its lock: deleting a buy that a later sale
 * depends on is refused. Writes a `trade.delete` audit log entry. `db` must be in a transaction.
 *
 * @returns the rows deleted; "not_found" when the workspace has no trade with this id;
 *   "reconciled" when a cash leg of the group is reconciled, and nothing is deleted.
 * @throws ValidationError with `validatePositionHistory`'s codes ("insufficient_quantity" and the
 *   others); nothing is deleted then.
 * @throws ConcurrentTradeChangeError as `updateTrade` does.
 */
export async function deleteTrade(
  db: DbClient,
  workspaceId: string,
  userId: string | null,
  tradeId: string,
): Promise<TradeRecord[] | "not_found" | "reconciled"> {
  const group = await lockTradeGroup(db, workspaceId, tradeId, undefined);
  if (!group) {
    return "not_found";
  }
  const ids = group.map((record) => record.id);
  if (await anyCashLegReconciled(db, workspaceId, ids)) {
    return "reconciled";
  }
  const instrumentId = group[0]!.instrumentId;
  if (instrumentId !== null) {
    const history = await loadInstrumentHistory(db, workspaceId, instrumentId);
    validatePositionHistory(applyTradeChanges(history, ids.map((id): TradeChange => ({ kind: "delete", tradeId: id }))));
  }

  await db.query("DELETE FROM trades WHERE workspace_id = $1 AND id = ANY($2)", [workspaceId, ids]);
  await recordAuditLog(db, { workspaceId, userId, action: "trade.delete", before: { trades: group }, after: null });
  return group;
}

/**
 * Brings a trade's cash leg in line with the trade as stored (ADR 0012): what a synced change to a
 * field of the trade runs once applied (`sync/apply.ts`), since the leg's amount, account and date
 * are never synced themselves. `previousAccountId` is the trade's account before the change, so a
 * move to another account sends a cleared leg back to pending (`rewriteTradeCashLeg`). Does nothing
 * when the workspace has no trade with this id.
 */
export async function rederiveTradeCashLeg(
  db: DbPool | DbClient,
  workspaceId: string,
  tradeId: string,
  previousAccountId?: string,
): Promise<void> {
  const { rows } = await db.query<ListedTradeRow>(
    `SELECT ${TRADE_COLUMNS}, NULL AS cash_transaction_id, NULL AS cash_status
     FROM trades t WHERE t.workspace_id = $1 AND t.id = $2`,
    [workspaceId, tradeId],
  );
  const row = rows[0];
  if (!row) {
    return;
  }
  const trade = toTradeRecord(row);
  await rewriteTradeCashLeg(db, {
    workspaceId,
    accountId: trade.accountId,
    tradeId: trade.id,
    tradeDate: trade.tradeDate,
    amountCents: trade.cashCents,
    ...(previousAccountId === undefined ? {} : { previousAccountId }),
  });
}

/** A trade's account as stored, or undefined: what `rederiveTradeCashLeg` needs from before a change. */
export async function tradeAccountId(db: DbPool | DbClient, workspaceId: string, tradeId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ account_id: string }>("SELECT account_id FROM trades WHERE workspace_id = $1 AND id = $2", [
    workspaceId,
    tradeId,
  ]);
  return rows[0]?.account_id;
}
