/**
 * Trades (#77; design.md, "Portfolio module"; ADR 0011 and ADR 0012): create and list. Editing and
 * deleting a trade are #509.
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
  regimeAt,
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
  type TradeType,
} from "@envelope/core";

import { listTaxRegimes } from "../accounts/tax-regimes.ts";
import { recordAuditLog } from "../audit-log/repository.ts";
import type { DbClient } from "../db/pool.ts";
import { createTradeCashLeg } from "../transactions/repository.ts";

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
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `trades:${workspaceId}:${instrumentId ?? "account-charges"}`,
  ]);
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

/**
 * The tax regime rules (#508), only in a workspace whose tax country has them (`IT`): every
 * brokerage account there needs a regime history (`tax_regime_required`; its first period also
 * covers earlier dates), and each row is checked against the regime in force on its trade date
 * (`checkTradeRegime`). Elsewhere there is no regime and nothing to check.
 */
async function checkRegimes(
  db: DbClient,
  workspaceId: string,
  rows: readonly NewTradeRow[],
  accounts: ReadonlyMap<string, AccountRef>,
  instrument: InstrumentRef | undefined,
): Promise<void> {
  const { rows: workspace } = await db.query<{ tax_country: string | null }>("SELECT tax_country FROM workspaces WHERE id = $1", [
    workspaceId,
  ]);
  if (workspace[0]?.tax_country !== TAX_REGIME_COUNTRY) {
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
        regime: regimeAt(history, row.tradeDate)!,
        domesticWithholdingAgent: accounts.get(accountId)!.domesticWithholdingAgent,
        instrumentType: instrument?.type ?? null,
      });
    }
  }
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
  const accounts = await checkReferences(db, workspaceId, rows, instrument);
  await checkIdsFree(db, workspaceId, rows.map((row) => row.id));

  for (const row of rows) {
    checkTradeEntry(row, instrument?.type ?? null);
  }
  await checkRegimes(db, workspaceId, rows, accounts, instrument);

  // The rows as the replay sees them once written: created now (the transaction's timestamp, the
  // same `now()` the created_at column defaults to), in the account's currency.
  const { rows: clock } = await db.query<{ now: Date }>("SELECT now() AS now");
  const createdAt = clock[0]!.now.toISOString();
  const inserts = rows.map(
    (row): PositionTrade => ({
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
    }),
  );
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
