/**
 * What the random walk checks (ADR 0013), in three kinds:
 * - the oracle: the state the API returns against `@envelope/core` applied to the model's log
 *   (`computePositions`, the summaries, `derivedResults`, `tradeCashCents`, `computeBudgetMonth`);
 * - model-free conservation checks, on the API's own answers only (the budget invariant, a
 *   transfer's legs, a trade's cash leg, a brokerage account's balance and its identity, the
 *   portfolios of an account adding up to it);
 * - isolation: a refused request changes no workspace (a digest of every workspace table but
 *   `audit_log` and the background job's `notified_budget_problems`, read through the superuser connection), and another workspace's token or id
 *   never reaches this workspace's rows.
 */
import {
  aggregateTransactions,
  compareMonths,
  computeBudgetMonth,
  computePositions,
  derivedResults,
  isValidationError,
  monthOf,
  summarizeByAccount,
  summarizeByPortfolio,
  tradeCashCents,
  UNASSIGNED,
  type AccountPosition,
  type BudgetAccount,
  type BudgetTransaction,
  type PortfolioPosition,
  type PositionSummary,
  type PositionTotals,
  type Positions,
} from "@envelope/core";

import type { DbPool } from "../../db/pool.ts";
import type { WalkDriver } from "./driver.ts";
import { LAST_MONTH, localDateOf, localMidnight, WINDOW_MONTHS } from "./generator.ts";
import { amountOf, type AccountEntity, type TradeJson, type TransactionJson, type WorkspaceModel } from "./model.ts";

/** A broken invariant or an unexpected answer: the walk stops and reports the seed and the step. */
export class WalkFailure extends Error {}

export function fail(message: string): never {
  throw new WalkFailure(message);
}

function show(value: unknown): string {
  return JSON.stringify(value, null, 1).slice(0, 4_000);
}

/** JSON with every object's keys sorted: two values compare equal whatever order their keys came in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) {
    fail(`${what}\n  API:      ${show(actual)}\n  expected: ${show(expected)}`);
  }
}

/**
 * The model stores what the API returned, so each accepted step first checks that the API kept
 * what was sent: a field the API silently changed (a fee dropped, a split's category lost) would
 * otherwise become the model's truth and go unnoticed. Each check is [field, sent, returned].
 */
export function expectEcho(what: string, checks: readonly (readonly [field: string, sent: unknown, returned: unknown])[]): void {
  const changed = checks.filter(([, sent, returned]) => canonical(sent) !== canonical(returned));
  if (changed.length > 0) {
    fail(`${what}: the API did not keep what was sent:\n${changed.map(([field, sent, returned]) => `  ${field}: sent ${canonical(sent)}, got ${canonical(returned)}`).join("\n")}`);
  }
}

const romeTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * What an `occurredAt` that was sent must come back as, compared as instants: a full timestamp is
 * the same instant whatever its format; a plain date is midnight of that date in the workspace's
 * time zone (design.md, "Accounting rules").
 */
export function instantEcho(field: string, sent: string, returned: string | null): readonly [string, unknown, unknown] {
  if (returned === null) return [field, sent, null];
  if (/^\d{4}-\d{2}-\d{2}$/.test(sent)) {
    const time = romeTime.format(new Date(returned));
    return [field, `${sent} 00:00`, `${localDateOf(returned)} ${time}`];
  }
  return [field, new Date(sent).toISOString(), new Date(returned).toISOString()];
}

export interface CheckContext {
  readonly driver: WalkDriver;
  /** Every reply the walk ever sees goes through here: none may be a 5xx. */
  readonly onResponse?: (status: number, method: string, path: string) => void;
}

/** A GET as the workspace's owner that must answer 200. */
export async function get(ctx: CheckContext, model: WorkspaceModel, path: string): Promise<unknown> {
  const response = await ctx.driver.request("GET", path, undefined, await model.users.owner.token());
  if (response.status >= 500) fail(`GET ${path} answered ${response.status}: ${show(response.body)}`);
  if (response.status !== 200) fail(`GET ${path} answered ${response.status}, expected 200: ${show(response.body)}`);
  return response.body;
}

function wsPath(model: WorkspaceModel, suffix: string): string {
  return `/workspaces/${model.workspaceId}${suffix}`;
}

// --- Transactions ----------------------------------------------------------------------------

function normalizeTransaction(record: TransactionJson): unknown {
  return {
    id: record.id,
    accountId: record.accountId,
    occurredAt: new Date(record.occurredAt).toISOString(),
    budgetDate: record.budgetDate,
    status: record.status,
    transferId: record.transferId,
    tradeId: record.tradeId,
    payee: record.payee,
    memo: record.memo,
    splits: record.splits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents })).sort((a, b) => a.amountCents - b.amountCents),
  };
}

/**
 * What the model expects of a transaction. A cash leg's amount, account and date are worked out
 * from its trade (ADR 0012: `tradeCashCents`, the trade's account, its trade date), never taken
 * from what the API answered for the leg.
 */
function expectedTransaction(model: WorkspaceModel, record: TransactionJson): unknown {
  if (record.tradeId === null) return normalizeTransaction(record);
  const trade = model.tradeById(record.tradeId);
  if (!trade) fail(`the model has a cash leg ${record.id} for trade ${record.tradeId}, which it does not have`);
  return normalizeTransaction({
    ...record,
    accountId: trade.record.accountId,
    occurredAt: localMidnight(trade.record.tradeDate),
    budgetDate: trade.record.tradeDate,
    splits: [{ categoryId: null, amountCents: tradeCashCents(trade.record), memo: null }],
  });
}

/** An account's transactions from the API, checked against the model. */
export async function checkAccountTransactions(ctx: CheckContext, model: WorkspaceModel, account: AccountEntity): Promise<TransactionJson[]> {
  const { transactions } = (await get(ctx, model, wsPath(model, `/accounts/${account.id}/transactions`))) as { transactions: TransactionJson[] };
  for (const record of transactions) {
    // The budget date is the instant's date in the workspace's time zone.
    if (record.budgetDate !== localDateOf(record.occurredAt)) {
      fail(`transaction ${record.id} at ${record.occurredAt} has budget date ${record.budgetDate}, not ${localDateOf(record.occurredAt)} in Europe/Rome`);
    }
  }
  const actual = transactions.map(normalizeTransaction).sort(byId);
  const expected = model.transactionsOf(account).map((e) => expectedTransaction(model, e.record)).sort(byId);
  expectEqual(actual, expected, `transactions of ${model.persona}/${account.handle} (${account.type})`);
  return transactions;
}

function byId(a: unknown, b: unknown): number {
  const x = (a as { id: string }).id;
  const y = (b as { id: string }).id;
  return x < y ? -1 : x > y ? 1 : 0;
}

// --- Trades ----------------------------------------------------------------------------------

/** The workspace's trades from the API, checked against the model: as stored, with the leg's own figures. */
export async function checkTrades(ctx: CheckContext, model: WorkspaceModel, query = ""): Promise<TradeJson[]> {
  const { trades } = (await get(ctx, model, wsPath(model, `/trades${query}`))) as { trades: TradeJson[] };
  const actual = [...trades].sort(byId);
  const expected = [...model.trades.values()]
    .map((entity) => {
      const leg = model.legOf(entity);
      return {
        ...entity.record,
        cashCents: tradeCashCents(entity.record),
        cashTransactionId: leg?.record.id ?? null,
        locked: leg?.record.status === "reconciled",
      };
    })
    .filter((record) => query === "" || query === `?accountId=${record.accountId}`)
    .sort(byId);
  expectEqual(actual.map(stripWorkspace), expected.map(stripWorkspace), `trades of ${model.persona}${query}`);
  return trades;
}

function stripWorkspace(record: TradeJson): unknown {
  const { workspaceId: _ignored, ...rest } = record as TradeJson & { workspaceId?: string };
  return Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// --- Positions -------------------------------------------------------------------------------

interface PositionResponse {
  readonly positions: (Record<string, unknown> & { instrument: { id: string }; accountId: string })[];
  readonly summaries: Record<string, unknown>[];
}

const TOTAL_KEYS: readonly (keyof PositionTotals)[] = [
  "realizedCents",
  "costInCents",
  "costSoldCents",
  "costTransferredOutCents",
  "tradeFeesCents",
  "incomeFeesCents",
  "transferFeesCents",
  "transactionTaxCents",
  "accruedInterestPaidCents",
  "accruedInterestReceivedCents",
  "gainTaxWithheldCents",
  "gainTaxAdjustmentsCents",
  "managedResultTaxCents",
  "incomeGrossCents",
  "withholdingForeignCents",
  "withholdingDomesticCents",
  "standaloneFeesCents",
  "standaloneTaxesCents",
];

function totals(row: PositionTotals): Record<string, number> {
  return { ...Object.fromEntries(TOTAL_KEYS.map((key) => [key, row[key]])), ...derivedResults(row) };
}

function expectedPositionRow(row: AccountPosition | PortfolioPosition): Record<string, unknown> {
  return {
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    currency: row.currency,
    quantityE8: row.quantity,
    costBasisCents: row.costBasisCents,
    accountAverageCostE6: row.averageCost,
    ...totals(row),
  };
}

function expectedSummary(summary: PositionSummary): Record<string, unknown> {
  return { currency: summary.currency, costBasisCents: summary.costBasisCents, ...totals(summary) };
}

function actualPositionRow(row: PositionResponse["positions"][number]): Record<string, unknown> {
  const keys = ["accountId", "currency", "quantityE8", "costBasisCents", "accountAverageCostE6", ...TOTAL_KEYS, "incomeCents", "costsCents", "taxesOnGainsCents"];
  return { instrumentId: row.instrument.id, ...Object.fromEntries(keys.map((key) => [key, row[key]])) };
}

function actualSummary(row: Record<string, unknown>): Record<string, unknown> {
  const keys = ["currency", "costBasisCents", ...TOTAL_KEYS, "incomeCents", "costsCents", "taxesOnGainsCents"];
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function sortRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const key = (row: Record<string, unknown>) => `${String(row.accountId)}|${String(row.instrumentId)}`;
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The oracle: every position of the workspace, replayed by the core from the model's trades. */
export function oraclePositions(model: WorkspaceModel): Positions {
  try {
    return computePositions(model.positionTrades());
  } catch (error) {
    if (isValidationError(error)) {
      fail(`the API accepted a trade history of ${model.persona} that the core refuses: ${error.code} ${show(error.details)}`);
    }
    throw error;
  }
}

export async function checkAccountPositions(ctx: CheckContext, model: WorkspaceModel, account: AccountEntity, oracle: Positions): Promise<PositionResponse> {
  const response = (await get(ctx, model, wsPath(model, `/accounts/${account.id}/positions`))) as PositionResponse;
  const own: Positions = {
    accounts: oracle.accounts.filter((row) => row.accountId === account.id),
    portfolios: [],
    charges: oracle.charges.filter((charge) => charge.accountId === account.id),
  };
  expectEqual(
    { positions: sortRows(response.positions.map(actualPositionRow)), summaries: response.summaries.map(actualSummary) },
    { positions: sortRows(own.accounts.map(expectedPositionRow)), summaries: summarizeByAccount(own).map(expectedSummary) },
    `positions of ${model.persona}/${account.handle}`,
  );
  return response;
}

export async function checkPortfolioPositions(ctx: CheckContext, model: WorkspaceModel, portfolioHandle: string, oracle: Positions): Promise<PositionResponse> {
  const { id } = model.portfolio(portfolioHandle);
  const response = (await get(ctx, model, wsPath(model, `/portfolios/${id}/positions`))) as PositionResponse;
  const own: Positions = {
    accounts: [],
    portfolios: oracle.portfolios.filter((row) => row.portfolioId === id),
    charges: oracle.charges.filter((charge) => charge.portfolioId === id),
  };
  expectEqual(
    { positions: sortRows(response.positions.map(actualPositionRow)), summaries: response.summaries.map(actualSummary) },
    { positions: sortRows(own.portfolios.map(expectedPositionRow)), summaries: summarizeByPortfolio(own).map(expectedSummary) },
    `positions of ${model.persona}/${portfolioHandle}`,
  );
  return response;
}

/**
 * Model-free: the portfolios' rows of each (account, instrument) add up to the account's row
 * (quantity and cost, the cost shares adding up exactly), and no portfolio ever holds less than
 * nothing.
 */
export function checkPortfoliosAddUp(accountRows: PositionResponse["positions"], portfolioRows: PositionResponse["positions"], what: string): void {
  const sums = new Map<string, { quantity: number; cost: number }>();
  for (const row of portfolioRows) {
    if ((row.quantityE8 as number) < 0) fail(`${what}: a portfolio holds a negative quantity: ${show(row)}`);
    const key = `${row.accountId}|${row.instrument.id}`;
    const sum = sums.get(key) ?? { quantity: 0, cost: 0 };
    sums.set(key, { quantity: sum.quantity + (row.quantityE8 as number), cost: sum.cost + (row.costBasisCents as number) });
  }
  for (const row of accountRows) {
    const key = `${row.accountId}|${row.instrument.id}`;
    const sum = sums.get(key) ?? { quantity: 0, cost: 0 };
    if (sum.quantity !== row.quantityE8 || sum.cost !== row.costBasisCents) {
      fail(`${what}: the portfolios of ${key} hold ${sum.quantity} units for ${sum.cost}, the account ${String(row.quantityE8)} for ${String(row.costBasisCents)}`);
    }
  }
}

// --- A brokerage account adds up (model-free) ----------------------------------------------------

/**
 * Model-free, on one brokerage account's own answers: every cash-moving trade has exactly one
 * leg, on its account, dated on its trade date, for the trade's cash; no leg without its trade;
 * so the balance is the money moved in (transfers, deposits) plus the trades' cash. And the
 * account identity (domain guide, "The account adds up"), with securities moved in or out
 * carrying their cost:
 *   realized + income − costs − taxes on gains
 *     = cash + cost − money in − cost brought in by transfers + cost carried out by transfers
 */
export function checkBrokerageAccount(
  account: AccountEntity,
  transactions: readonly TransactionJson[],
  trades: readonly TradeJson[],
  positions: PositionResponse,
  what: string,
): void {
  const own = trades.filter((t) => t.accountId === account.id);
  const legsById = new Map(transactions.filter((t) => t.tradeId !== null).map((t) => [t.id, t]));
  for (const trade of own) {
    if (trade.cashCents === 0) {
      if (trade.cashTransactionId !== null) fail(`${what}: trade ${trade.id} moves no cash but has leg ${trade.cashTransactionId}`);
      continue;
    }
    const leg = trade.cashTransactionId === null ? undefined : legsById.get(trade.cashTransactionId);
    if (!leg) fail(`${what}: trade ${trade.id} moves ${trade.cashCents} but its leg is not on the account`);
    if (leg.tradeId !== trade.id || amountOf(leg) !== trade.cashCents || leg.budgetDate !== trade.tradeDate || leg.splits.length !== 1 || leg.splits[0]!.categoryId !== null) {
      fail(`${what}: the leg of trade ${trade.id} does not match it:\n trade ${show(trade)}\n leg ${show(leg)}`);
    }
    legsById.delete(leg.id);
  }
  if (legsById.size > 0) fail(`${what}: legs without a trade of this account: ${show([...legsById.values()])}`);

  const cash = transactions.reduce((sum, t) => sum + amountOf(t), 0);
  const moneyIn = transactions.filter((t) => t.tradeId === null).reduce((sum, t) => sum + amountOf(t), 0);
  const tradeCash = own.reduce((sum, t) => sum + t.cashCents, 0);
  if (cash !== moneyIn + tradeCash) fail(`${what}: balance ${cash} is not the money moved in ${moneyIn} plus the trades' cash ${tradeCash}`);

  const summary = positions.summaries[0] as Record<string, number> | undefined;
  if (positions.summaries.length > 1) fail(`${what}: more than one currency on a EUR account: ${show(positions.summaries)}`);
  const s = (key: string): number => summary?.[key] ?? 0;
  const boughtCost = own.filter((t) => t.type === "buy").reduce((sum, t) => sum + t.grossCents + t.feesCents, 0);
  // The cost securities brought in by transfers, taken from the API's own cost in: this check is
  // model-free on purpose. That cost in is not trusted blindly: every position and summary,
  // `costInCents` included, is compared with the core's replay of the model's trades (the
  // positions oracle) on the same step, so a wrong figure fails there.
  const costInByTransfers = s("costInCents") - boughtCost;
  const left = s("realizedCents") + s("incomeCents") - s("costsCents") - s("taxesOnGainsCents");
  const right = cash + s("costBasisCents") - moneyIn - costInByTransfers + s("costTransferredOutCents");
  if (left !== right) {
    fail(`${what}: the account does not add up: realized + income − costs − taxes = ${left}, cash + cost − money in − cost in by transfers + cost out = ${right}\n summary ${show(summary)}`);
  }
}

// --- The budget ----------------------------------------------------------------------------------

interface BudgetMonthResponse {
  readonly month: string;
  readonly unassigned: number;
  readonly assignedInFuture: number;
  readonly overspentLastMonth: number;
  readonly creditOverspending: number;
  readonly reserved: number;
  readonly categories: readonly Record<string, unknown>[];
  readonly paymentCategories: readonly Record<string, unknown>[];
}

const CATEGORY_KEYS = ["categoryId", "carriedOver", "assigned", "activity", "available", "creditOverspending", "cashOverspending", "reserved", "uncovered", "owed"];

function pickCategory(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CATEGORY_KEYS.map((key) => [key, row[key]]));
}

function byCategory(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return String(a.categoryId) < String(b.categoryId) ? -1 : 1;
}

/**
 * The walk's today, in the workspace's time zone: the API reads its own from the database clock,
 * the same instant to within the length of a request. The window is in the past, so every date
 * of the walk is on or before it.
 */
export function walkToday(): string {
  return localDateOf(new Date().toISOString());
}

/** The model's transactions aggregated the way the design document's accounting rules say. */
function oracleAggregated(model: WorkspaceModel): ReturnType<typeof aggregateTransactions> {
  const accounts: BudgetAccount[] = [...model.accounts.values()].map((a) => ({
    id: a.id,
    type: a.type === "credit_card" ? "credit" : "cash",
    onBudget: a.onBudget,
    ...(a.paymentCategory ? { paymentCategoryId: model.category(a.paymentCategory).id } : {}),
  }));
  const records = [...model.transactions.values()].map((e) => e.record);
  const accountOf = new Map(records.map((r) => [r.id, r.accountId]));
  const transactions: BudgetTransaction[] = records.map((r) => {
    const amount = amountOf(r);
    if (r.transferId !== null) {
      const categoryId = r.splits.length === 1 ? (r.splits[0]!.categoryId ?? null) : null;
      const transferAccountId = accountOf.get(r.transferId);
      return { id: r.id, accountId: r.accountId, date: r.budgetDate, amount, ...(transferAccountId ? { transferAccountId } : {}), ...(categoryId ? { categoryId } : {}) };
    }
    if (r.splits.length === 1 && r.splits[0]!.categoryId === null) {
      return { id: r.id, accountId: r.accountId, date: r.budgetDate, amount, categoryId: UNASSIGNED };
    }
    return { id: r.id, accountId: r.accountId, date: r.budgetDate, amount, splits: r.splits.map((s) => ({ categoryId: s.categoryId!, amount: s.amountCents })) };
  });
  return aggregateTransactions(accounts, transactions);
}

/**
 * The oracle for a budget month: `computeBudgetMonth` on the model's transactions (no
 * assignments or scheduled transactions in the walk yet, #533), with the walk's today.
 */
export function oracleBudgetMonth(model: WorkspaceModel, month: string): ReturnType<typeof computeBudgetMonth> {
  const records = [...model.transactions.values()].map((e) => e.record);
  const aggregated = oracleAggregated(model);
  const cards = model.cards().filter((card) => card.paymentCategory !== null);
  return computeBudgetMonth(
    {
      categoryIds: model.ordinaryCategories().map((c) => c.id),
      paymentCategoryIds: cards.map((card) => model.category(card.paymentCategory!).id),
      income: aggregated.income,
      assignments: [],
      activity: aggregated.activity,
      cardPayments: aggregated.cardPayments,
      cardTransfers: aggregated.cardTransfers,
      cardBalances: cards.map((card) => ({
        paymentCategoryId: model.category(card.paymentCategory!).id,
        owed: -records.filter((r) => r.accountId === card.id && compareMonths(monthOf(r.budgetDate), month) <= 0).reduce((sum, r) => sum + amountOf(r), 0),
        hasStartingBalance: false,
      })),
      scheduledItems: [],
      today: walkToday(),
    },
    month,
  );
}

/**
 * Each on-budget cash account's balance at the end of `month`, from the transactions the API
 * listed for it.
 */
export function balancesAtEndOf(model: WorkspaceModel, byAccount: ReadonlyMap<string, readonly TransactionJson[]>, month: string): Map<string, number> {
  const balances = new Map<string, number>();
  for (const account of model.budgetCashAccounts()) {
    const transactions = byAccount.get(account.id) ?? fail(`no transactions read for ${account.handle}`);
    balances.set(account.id, transactions.filter((t) => compareMonths(monthOf(t.budgetDate), month) <= 0).reduce((sum, t) => sum + amountOf(t), 0));
  }
  return balances;
}

/**
 * A budget month against the oracle. Given the on-budget cash accounts' balances at the end of
 * `month` (`balances`, read from the API), also the model-free budget invariant (#650):
 * unassigned + every category's available + assigned in future + credit overspending + reserved
 * = the balance of the on-budget cash accounts (cards excluded) at the end of the month, less
 * every positive split on them dated in it or before but after today: income, a refund, a
 * categorized transfer in (not received yet, so it counts nowhere, #668). A card's refund dated
 * after today moves nothing between its category and the payment category, so it leaves the sum
 * alone. The refund term cannot fire yet: the walk never dates a transaction after today.
 */
export async function checkBudgetMonth(ctx: CheckContext, model: WorkspaceModel, month: string, balances?: ReadonlyMap<string, number>): Promise<BudgetMonthResponse> {
  const actual = (await get(ctx, model, wsPath(model, `/budget-months/${month}`))) as BudgetMonthResponse;
  if (balances) {
    const budgeted =
      actual.unassigned +
      [...actual.categories, ...actual.paymentCategories].reduce((sum, c) => sum + (c.available as number), 0) +
      actual.assignedInFuture +
      actual.creditOverspending +
      actual.reserved;
    const today = walkToday();
    const aggregated = oracleAggregated(model);
    const notReceived =
      aggregated.income.filter((i) => compareMonths(i.month, month) <= 0 && i.date !== undefined && i.date > today).reduce((sum, i) => sum + i.amount, 0) +
      aggregated.activity
        .filter((a) => a.paymentCategoryId === undefined && a.amount > 0 && compareMonths(a.month, month) <= 0 && a.date !== undefined && a.date > today)
        .reduce((sum, a) => sum + a.amount, 0);
    const cash = model.budgetCashAccounts().reduce((sum, account) => sum + (balances.get(account.id) ?? fail(`no balance read for ${account.handle}`)), 0) - notReceived;
    if (budgeted !== cash) fail(`budget invariant of ${model.persona} in ${month}: the budget holds ${budgeted}, the on-budget accounts ${cash} at the end of the month`);
  }
  const expected = oracleBudgetMonth(model, month);
  expectEqual(
    {
      month: actual.month,
      unassigned: actual.unassigned,
      assignedInFuture: actual.assignedInFuture,
      overspentLastMonth: actual.overspentLastMonth,
      creditOverspending: actual.creditOverspending,
      reserved: actual.reserved,
      categories: actual.categories.map(pickCategory).sort(byCategory),
      paymentCategories: actual.paymentCategories.map(pickCategory).sort(byCategory),
    },
    {
      month: expected.month,
      unassigned: expected.unassigned,
      assignedInFuture: expected.assignedInFuture,
      overspentLastMonth: expected.overspentLastMonth,
      creditOverspending: expected.creditOverspending,
      reserved: expected.reserved,
      categories: expected.categories.map((c) => pickCategory(c as unknown as Record<string, unknown>)).sort(byCategory),
      paymentCategories: expected.paymentCategories.map((c) => pickCategory(c as unknown as Record<string, unknown>)).sort(byCategory),
    },
    `budget month ${month} of ${model.persona}`,
  );
  return actual;
}

/** Model-free: each transfer's two legs exist, point at each other, and move opposite amounts. */
export function checkTransferPairs(transactions: readonly TransactionJson[], what: string): void {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  for (const t of transactions) {
    if (t.transferId === null) continue;
    const partner = byId.get(t.transferId);
    if (!partner) fail(`${what}: transfer leg ${t.id} points at ${t.transferId}, which no account of the workspace has`);
    if (partner.transferId !== t.id) fail(`${what}: transfer legs ${t.id} and ${partner.id} do not point at each other`);
    if (amountOf(t) + amountOf(partner) !== 0) {
      fail(`${what}: transfer legs ${t.id} (${amountOf(t)} on ${t.accountId}) and ${partner.id} (${amountOf(partner)} on ${partner.accountId}) do not cancel out`);
    }
  }
}

// --- The full comparison -------------------------------------------------------------------------

/** Every check of one workspace: run every k steps and at the end of a walk. */
export async function fullCheck(ctx: CheckContext, model: WorkspaceModel): Promise<void> {
  const what = `full check of ${model.persona}`;
  const all: TransactionJson[] = [];
  const byAccount = new Map<string, TransactionJson[]>();
  for (const account of model.accounts.values()) {
    const transactions = await checkAccountTransactions(ctx, model, account);
    byAccount.set(account.id, transactions);
    all.push(...transactions);
  }
  checkTransferPairs(all, what);

  const trades = await checkTrades(ctx, model);
  const oracle = oraclePositions(model);
  const accountRows: PositionResponse["positions"] = [];
  for (const account of model.brokerageAccounts()) {
    const positions = await checkAccountPositions(ctx, model, account, oracle);
    accountRows.push(...positions.positions);
    checkBrokerageAccount(account, byAccount.get(account.id) ?? [], trades, positions, `${what}, ${account.handle}`);
  }
  const portfolioRows: PositionResponse["positions"] = [];
  for (const handle of model.portfolios.keys()) {
    portfolioRows.push(...(await checkPortfolioPositions(ctx, model, handle, oracle)).positions);
  }
  checkPortfoliosAddUp(accountRows, portfolioRows, what);

  // Every month walked, each against the balances at its own end (#650).
  const months = model.persona === "investor" ? [LAST_MONTH] : WINDOW_MONTHS;
  for (const month of months) {
    await checkBudgetMonth(ctx, model, month, balancesAtEndOf(model, byAccount, month));
  }

  // No change was ever applied through sync in this walk: a pull lists nothing, and certainly
  // nothing of another workspace.
  const { changes } = (await get(ctx, model, wsPath(model, "/changes"))) as { changes: { entityId: string }[] };
  for (const change of changes) {
    if (!model.transactionById(change.entityId)) fail(`${what}: the sync pull lists a change to ${change.entityId}, not a transaction of this workspace`);
  }
}

// --- Isolation -------------------------------------------------------------------------------------

/**
 * A digest of every row of every workspace table, per workspace, through the superuser
 * connection (no Row-Level Security in the way): a refused request must leave it as it was.
 * `audit_log` is left out: it records attempts, not data. So is `notified_budget_problems`, which only
 * the `budget-recompute` job writes, in the background: through the real process (the `fetch`
 * driver) a job queued by an earlier step can write it while a refused request is being checked.
 */
const DIGEST_EXCLUDED_TABLES: readonly string[] = ["audit_log", "notified_budget_problems"];

export class WorkspaceDigest {
  private readonly sql: string;

  private constructor(sql: string) {
    this.sql = sql;
  }

  static async prepare(pool: DbPool): Promise<WorkspaceDigest> {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> ALL($1)
       ORDER BY c.table_name`,
      [DIGEST_EXCLUDED_TABLES],
    );
    const parts = rows.map(
      ({ table_name }) =>
        `SELECT '${table_name}' AS t, workspace_id::text AS w, md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM "${table_name}" x WHERE workspace_id = ANY($1) GROUP BY workspace_id`,
    );
    parts.push(`SELECT 'workspaces' AS t, id::text AS w, md5(x::text) AS h FROM workspaces x WHERE id = ANY($1)`);
    return new WorkspaceDigest(parts.join("\nUNION ALL\n"));
  }

  async read(pool: DbPool, workspaceIds: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await pool.query<{ t: string; w: string; h: string }>(this.sql, [workspaceIds]);
    return new Map(rows.map((row) => [`${row.w}/${row.t}`, row.h]));
  }
}

export function compareDigests(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, what: string): void {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
  if (changed.length > 0) fail(`${what} changed data: ${changed.join(", ")}`);
}

/**
 * One isolation probe for an entity the step created: another persona's owner neither reaches it
 * through its own workspace nor reads the victim's workspace at all.
 */
export async function probeIsolation(
  ctx: CheckContext,
  victim: WorkspaceModel,
  intruder: WorkspaceModel,
  created: { readonly kind: "account" | "portfolio" | "transaction" | "trade"; readonly id: string },
  /** Picks one of the two probes of the entity's kind, so a step costs one request. */
  step: number,
): Promise<void> {
  const token = await intruder.users.owner.token();
  const expectStatus = async (path: string, statuses: readonly number[]): Promise<unknown> => {
    const response = await ctx.driver.request("GET", path, undefined, token);
    if (!statuses.includes(response.status)) {
      fail(`isolation: ${intruder.persona}'s owner GET ${path} answered ${response.status}, expected ${statuses.join(" or ")}: ${show(response.body)}`);
    }
    return response.body;
  };
  const mustNotList = (body: unknown, what: string): void => {
    if (JSON.stringify(body).includes(created.id)) fail(`isolation: ${what} of ${intruder.persona} lists ${victim.persona}'s ${created.kind} ${created.id}`);
  };

  switch (created.kind) {
    case "account":
      if (step % 2 === 0) await expectStatus(wsPath(intruder, `/accounts/${created.id}/transactions`), [404]);
      else await expectStatus(wsPath(victim, "/accounts"), [403]);
      break;
    case "portfolio":
      if (step % 2 === 0) await expectStatus(wsPath(intruder, `/portfolios/${created.id}`), [404]);
      else await expectStatus(wsPath(intruder, `/portfolios/${created.id}/positions`), [404]);
      break;
    case "transaction":
      if (step % 2 === 0) mustNotList(await expectStatus(wsPath(intruder, "/changes"), [200]), "the sync pull");
      else await expectStatus(wsPath(victim, `/budget-months/${LAST_MONTH}`), [403]);
      break;
    case "trade":
      if (step % 2 === 0) mustNotList(await expectStatus(wsPath(intruder, "/trades"), [200]), "the trades");
      else await expectStatus(wsPath(victim, "/trades"), [403]);
      break;
  }
}
