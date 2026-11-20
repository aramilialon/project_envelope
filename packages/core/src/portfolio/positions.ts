/**
 * Positions computed from trades (design.md, "Portfolio module"; ADR 0011).
 *
 * A position is never stored: it is rebuilt by replaying the trades of one
 * account and instrument in a fixed order, so every rebuild gives the same
 * result to the cent and to the 10^-8 unit.
 *
 * - The cost method is the weighted average cost **per account and
 *   instrument**, shared by every portfolio of that account holding it.
 *   Portfolios split the account's *quantity*, not its cost: moving units
 *   between two portfolios of the same account never changes the cost.
 * - `C` is the total cost in the account's minor unit, `Q` the quantity. The
 *   average cost is C ÷ Q for display only (`priceFrom`, half to even); it is
 *   never stored and never used to compute anything else.
 * - Cost basis follows the Italian rules (art. 68 TUIR):
 *   - buy: C += gross + fees; the transaction tax and accrued interest are not
 *     part of the cost and are kept as their own totals;
 *   - sell: removed = proportionalCost(C, sold, Q); realized = gross − fees −
 *     removed, attributed to the portfolio of the sale; gain tax, transaction
 *     tax and withholdings are not part of the gain;
 *   - transfer between two accounts: the incoming leg adds the cost it
 *     carries, the outgoing leg removes its proportional cost, no gain;
 *     between two portfolios of the same account: quantity only;
 *   - split: each portfolio's quantity × to ÷ from, toward zero to 8 decimals,
 *     C unchanged, no gain;
 *   - dividends, coupons, standalone fees and taxes: C unchanged.
 * - Replay order: `(date, split first, occurredAt, createdAt, id)`. A split
 *   applies at the start of its date, before every other trade of that date.
 * - No portfolio may hold a negative quantity at any point of the replay.
 */

import { ValidationError } from "../errors.ts";
import type { Cents, CurrencyCode } from "../money.ts";
import { assertCents } from "../money.ts";
import type { LocalDate } from "../month.ts";
import { assertDate } from "../month.ts";
import type { Price, PriceFactor, Quantity } from "./quantity.ts";
import { amountOf, assertPrice, assertPriceFactor, assertQuantity, priceFrom, proportionalCost, toQuantity } from "./quantity.ts";

export type TradeType = "buy" | "sell" | "dividend" | "fee" | "tax" | "split" | "transfer";

export type TaxKind = "stamp_duty" | "managed_result_tax" | "gain_tax_adjustment" | "other";

const TRADE_TYPES: ReadonlySet<string> = new Set<TradeType>(["buy", "sell", "dividend", "fee", "tax", "split", "transfer"]);

/**
 * One trade, as the replay needs it: the columns of the `trades` table plus
 * three values the caller joins in (`date`, `currency`, `priceFactor`).
 * Every `*Cents` is in the account's currency.
 */
export interface PositionTrade {
  readonly id: string;
  readonly accountId: string;
  readonly portfolioId: string;
  /** Null only for an account-wide fee or tax. */
  readonly instrumentId: string | null;
  readonly type: TradeType;
  /** When the trade happened, as an ISO 8601 timestamp. */
  readonly occurredAt: string;
  /** The day of `occurredAt` in the workspace's time zone (a split applies at its start). */
  readonly date: LocalDate;
  /** When the trade was recorded, as an ISO 8601 timestamp: breaks ties in the replay order. */
  readonly createdAt: string;
  /** The account's currency. */
  readonly currency: CurrencyCode;
  /**
   * Units × 10^8. Positive on a buy and a sell (the type gives the
   * direction); on a transfer, negative on the outgoing leg and positive on
   * the incoming one. Ignored by the other types.
   */
  readonly quantity: Quantity;
  readonly price: Price;
  /** The instrument's price factor. */
  readonly priceFactor: PriceFactor;
  /** Buy and sell: the amount of the units; dividend: the gross income; tax: the tax amount. */
  readonly grossCents: Cents;
  readonly feesCents: Cents;
  readonly transactionTaxCents: Cents;
  readonly accruedInterestCents: Cents;
  readonly withholdingForeignCents: Cents;
  readonly withholdingDomesticCents: Cents;
  readonly gainTaxCents: Cents;
  readonly taxKind: TaxKind | null;
  /** The cost carried by the incoming leg of a transfer between two accounts. */
  readonly costBasisCents: Cents | null;
  readonly splitFrom: number | null;
  readonly splitTo: number | null;
  /** The other leg of a transfer. */
  readonly transferTradeId: string | null;
}

/** Running totals of a position, each in the account's minor unit. */
export interface PositionTotals {
  /** Gains (positive) and losses (negative) realized by sales. */
  readonly realizedCents: Cents;
  /** Cost that entered the position: buys (gross + fees) and transfers in from another account. */
  readonly costInCents: Cents;
  /** Cost removed by sales. */
  readonly costSoldCents: Cents;
  /** Cost carried out by transfers to another account. */
  readonly costTransferredOutCents: Cents;
  /** Fees of buys, sells and dividends. */
  readonly feesCents: Cents;
  /** Transaction taxes (the financial transaction tax and similar), never part of the cost. */
  readonly transactionTaxCents: Cents;
  /** Accrued interest paid on buys, never part of the cost. */
  readonly accruedInterestPaidCents: Cents;
  /** Accrued interest received on sells, never part of the gain. */
  readonly accruedInterestReceivedCents: Cents;
  /** Gain tax withheld on sales. */
  readonly gainTaxCents: Cents;
  /** Dividends and coupons, gross. */
  readonly dividendsCents: Cents;
  readonly withholdingForeignCents: Cents;
  /** Signed: a bond trade with accrued interest can carry a negative domestic withholding. */
  readonly withholdingDomesticCents: Cents;
  /** Fee trades. */
  readonly standaloneFeesCents: Cents;
  /** Tax trades; a gain tax adjustment (money back) counts negative. */
  readonly standaloneTaxesCents: Cents;
}

/** A position per account and instrument. */
export interface AccountPosition extends PositionTotals {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly currency: CurrencyCode;
  readonly priceFactor: PriceFactor;
  readonly quantity: Quantity;
  readonly costBasisCents: Cents;
  /** C ÷ Q, half to even, for display only; null when the quantity is zero. */
  readonly averageCost: Price | null;
}

/**
 * A portfolio's share of an account's position. The quantity is its own; the
 * cost is the account's cost split by quantity (largest remainder, so the
 * parts add up to the account's cost exactly) and the average cost is the
 * account's. The totals count the portfolio's own trades.
 */
export interface PortfolioPosition extends PositionTotals {
  readonly portfolioId: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly currency: CurrencyCode;
  readonly priceFactor: PriceFactor;
  readonly quantity: Quantity;
  readonly costBasisCents: Cents;
  /** The account's average cost; null when this portfolio holds nothing. */
  readonly averageCost: Price | null;
}

/** Fees and taxes of an account recorded without an instrument (custody, stamp duty), per portfolio. */
export interface AccountCharge {
  readonly accountId: string;
  readonly portfolioId: string;
  readonly currency: CurrencyCode;
  readonly standaloneFeesCents: Cents;
  /** A gain tax adjustment (money back) counts negative. */
  readonly standaloneTaxesCents: Cents;
}

export interface Positions {
  /** Sorted by account, then instrument. Positions sold out are kept, for their totals. */
  readonly accounts: readonly AccountPosition[];
  /** Sorted by account, instrument, then portfolio. */
  readonly portfolios: readonly PortfolioPosition[];
  /** Sorted by account, then portfolio. */
  readonly charges: readonly AccountCharge[];
}

/** Totals of several positions in one currency, plus their cost. */
export interface PositionSummary extends PositionTotals {
  readonly currency: CurrencyCode;
  readonly costBasisCents: Cents;
}

export interface PortfolioSummary extends PositionSummary {
  readonly portfolioId: string;
}

export interface AccountSummary extends PositionSummary {
  readonly accountId: string;
}

/** A change to a trade history, to validate before it is written. */
export type TradeChange =
  | { readonly kind: "insert"; readonly trade: PositionTrade }
  | { readonly kind: "update"; readonly trade: PositionTrade }
  | { readonly kind: "delete"; readonly tradeId: string };

// --- Totals -----------------------------------------------------------------

type MutableTotals = { -readonly [K in keyof PositionTotals]: Cents };

const TOTAL_KEYS: readonly (keyof PositionTotals)[] = [
  "realizedCents",
  "costInCents",
  "costSoldCents",
  "costTransferredOutCents",
  "feesCents",
  "transactionTaxCents",
  "accruedInterestPaidCents",
  "accruedInterestReceivedCents",
  "gainTaxCents",
  "dividendsCents",
  "withholdingForeignCents",
  "withholdingDomesticCents",
  "standaloneFeesCents",
  "standaloneTaxesCents",
];

function emptyTotals(): MutableTotals {
  const totals = {} as MutableTotals;
  for (const key of TOTAL_KEYS) totals[key] = 0;
  return totals;
}

function plus(a: Cents, b: Cents, label: string): Cents {
  const sum = a + b;
  assertCents(sum, label);
  return sum;
}

function add(totals: MutableTotals, key: keyof PositionTotals, amount: Cents): void {
  totals[key] = plus(totals[key], amount, key);
}

function addAll(target: MutableTotals, source: PositionTotals): void {
  for (const key of TOTAL_KEYS) add(target, key, source[key]);
}

function pickTotals(source: PositionTotals): PositionTotals {
  const totals = emptyTotals();
  addAll(totals, source);
  return totals;
}

// --- Validation of single trades ----------------------------------------------

function invalidTrade(trade: PositionTrade, field: string, message: string): ValidationError {
  return new ValidationError("invalid_trade", `trade ${trade.id}: ${message}`, { tradeId: trade.id, field });
}

function timestampOf(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ValidationError("invalid_date", `${label} is not an ISO 8601 timestamp: "${value}"`, { value });
  }
  return ms;
}

const CENTS_FIELDS = [
  "grossCents",
  "feesCents",
  "transactionTaxCents",
  "accruedInterestCents",
  "withholdingForeignCents",
  "withholdingDomesticCents",
  "gainTaxCents",
] as const;

function checkTrade(trade: PositionTrade): void {
  if (!TRADE_TYPES.has(trade.type)) throw invalidTrade(trade, "type", `unknown type "${String(trade.type)}"`);
  assertDate(trade.date);
  assertQuantity(trade.quantity);
  assertPrice(trade.price);
  assertPriceFactor(trade.priceFactor);
  for (const field of CENTS_FIELDS) assertCents(trade[field], field);
  if (trade.costBasisCents !== null) assertCents(trade.costBasisCents, "costBasisCents");
  if (trade.instrumentId === null && trade.type !== "fee" && trade.type !== "tax") {
    throw invalidTrade(trade, "instrumentId", `a ${trade.type} needs an instrument`);
  }
  if ((trade.type === "buy" || trade.type === "sell") && trade.quantity <= 0) {
    throw invalidTrade(trade, "quantity", `a ${trade.type} needs a positive quantity`);
  }
  if (trade.type === "transfer") {
    if (trade.quantity === 0) throw invalidTrade(trade, "quantity", "a transfer needs a non-zero quantity");
    if (trade.transferTradeId === null) throw invalidTrade(trade, "transferTradeId", "a transfer needs its other leg");
  }
  if (trade.type === "split") {
    for (const field of ["splitFrom", "splitTo"] as const) {
      const value = trade[field];
      if (value === null || !Number.isSafeInteger(value) || value <= 0) {
        throw invalidTrade(trade, field, "a split needs a ratio of two positive integers");
      }
    }
  }
}

// --- Replay -----------------------------------------------------------------

interface SortableTrade {
  readonly trade: PositionTrade;
  readonly occurredMs: number;
  readonly createdMs: number;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The replay order: date, splits first, then occurredAt, createdAt and id. */
function compareReplay(a: SortableTrade, b: SortableTrade): number {
  return (
    compareIds(a.trade.date, b.trade.date) ||
    (a.trade.type === "split" ? 0 : 1) - (b.trade.type === "split" ? 0 : 1) ||
    a.occurredMs - b.occurredMs ||
    a.createdMs - b.createdMs ||
    compareIds(a.trade.id, b.trade.id)
  );
}

interface PortfolioState {
  quantity: Quantity;
  readonly totals: MutableTotals;
}

interface GroupState {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly currency: CurrencyCode;
  readonly priceFactor: PriceFactor;
  quantity: Quantity;
  cost: Cents;
  readonly portfolios: Map<string, PortfolioState>;
}

function portfolioOf(state: GroupState, portfolioId: string): PortfolioState {
  let portfolio = state.portfolios.get(portfolioId);
  if (portfolio === undefined) {
    portfolio = { quantity: 0 as Quantity, totals: emptyTotals() };
    state.portfolios.set(portfolioId, portfolio);
  }
  return portfolio;
}

function changeQuantity(state: GroupState, portfolio: PortfolioState, delta: number): void {
  portfolio.quantity = toQuantity(portfolio.quantity + delta);
  state.quantity = toQuantity(state.quantity + delta);
}

function requireQuantity(state: GroupState, portfolioId: string, trade: PositionTrade, requested: number): PortfolioState {
  const portfolio = portfolioOf(state, portfolioId);
  if (requested > portfolio.quantity) {
    throw new ValidationError(
      "insufficient_quantity",
      `portfolio ${portfolioId} holds ${portfolio.quantity} of instrument ${state.instrumentId} on ${trade.date}, not ${requested} (units × 10^8)`,
      {
        tradeId: trade.id,
        accountId: state.accountId,
        portfolioId,
        instrumentId: state.instrumentId,
        date: trade.date,
        available: portfolio.quantity,
        requested,
      },
    );
  }
  return portfolio;
}

function applySplits(state: GroupState, splits: readonly PositionTrade[]): void {
  const first = splits[0];
  if (first === undefined) return;
  const covered = new Set(splits.map((split) => split.portfolioId));
  const uncovered = [...state.portfolios.entries()]
    .filter(([id, portfolio]) => portfolio.quantity > 0 && !covered.has(id))
    .map(([id]) => id)
    .sort(compareIds);
  const missing = uncovered[0];
  if (missing !== undefined) {
    throw new ValidationError(
      "split_missing_for_portfolio",
      `portfolio ${missing} holds instrument ${state.instrumentId} on ${first.date} but has no split row`,
      { accountId: state.accountId, portfolioId: missing, instrumentId: state.instrumentId, date: first.date },
    );
  }
  for (const split of splits) {
    const portfolio = portfolioOf(state, split.portfolioId);
    // Ratio checked by checkTrade; toward zero, to 8 decimals.
    const scaled = (BigInt(portfolio.quantity) * BigInt(split.splitTo ?? 1)) / BigInt(split.splitFrom ?? 1);
    const next = toQuantity(Number(scaled));
    changeQuantity(state, portfolio, next - portfolio.quantity);
  }
  if (state.quantity === 0 && state.cost !== 0) {
    throw new ValidationError(
      "split_leaves_no_quantity",
      `the split on ${first.date} rounds the whole position in instrument ${state.instrumentId} down to zero`,
      { accountId: state.accountId, instrumentId: state.instrumentId, date: first.date },
    );
  }
}

/** Replays one account and instrument's trades, already sorted. */
function replay(
  accountId: string,
  instrumentId: string,
  sorted: readonly PositionTrade[],
  byId: ReadonlyMap<string, PositionTrade>,
): GroupState {
  const head = sorted[0];
  if (head === undefined) throw new Error("replay of an empty group");
  const state: GroupState = {
    accountId,
    instrumentId,
    currency: head.currency,
    priceFactor: head.priceFactor,
    quantity: 0 as Quantity,
    cost: 0,
    portfolios: new Map(),
  };
  const done = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const trade = sorted[i] as PositionTrade;
    if (done.has(trade.id)) continue;
    if (trade.currency !== state.currency) throw invalidTrade(trade, "currency", "differs from the position's currency");
    if (trade.priceFactor !== state.priceFactor) {
      throw invalidTrade(trade, "priceFactor", "differs from the position's price factor");
    }

    if (trade.type === "split") {
      const splits: PositionTrade[] = [];
      for (let j = i; j < sorted.length; j++) {
        const other = sorted[j] as PositionTrade;
        if (other.type !== "split" || other.date !== trade.date) break;
        splits.push(other);
        done.add(other.id);
      }
      applySplits(state, splits);
      continue;
    }

    const portfolio = portfolioOf(state, trade.portfolioId);
    const totals = portfolio.totals;
    switch (trade.type) {
      case "buy": {
        const cost = plus(trade.grossCents, trade.feesCents, "cost");
        state.cost = plus(state.cost, cost, "costBasisCents");
        changeQuantity(state, portfolio, trade.quantity);
        add(totals, "costInCents", cost);
        add(totals, "feesCents", trade.feesCents);
        add(totals, "transactionTaxCents", trade.transactionTaxCents);
        add(totals, "accruedInterestPaidCents", trade.accruedInterestCents);
        add(totals, "withholdingDomesticCents", trade.withholdingDomesticCents);
        break;
      }
      case "sell": {
        requireQuantity(state, trade.portfolioId, trade, trade.quantity);
        const removed = proportionalCost(state.cost, trade.quantity, state.quantity);
        state.cost = plus(state.cost, -removed, "costBasisCents");
        changeQuantity(state, portfolio, -trade.quantity);
        const proceeds = plus(trade.grossCents, -trade.feesCents, "proceeds");
        add(totals, "realizedCents", plus(proceeds, -removed, "realized"));
        add(totals, "costSoldCents", removed);
        add(totals, "feesCents", trade.feesCents);
        add(totals, "transactionTaxCents", trade.transactionTaxCents);
        add(totals, "accruedInterestReceivedCents", trade.accruedInterestCents);
        add(totals, "gainTaxCents", trade.gainTaxCents);
        add(totals, "withholdingDomesticCents", trade.withholdingDomesticCents);
        break;
      }
      case "dividend":
        add(totals, "dividendsCents", trade.grossCents);
        add(totals, "feesCents", trade.feesCents);
        add(totals, "withholdingForeignCents", trade.withholdingForeignCents);
        add(totals, "withholdingDomesticCents", trade.withholdingDomesticCents);
        break;
      case "fee":
        add(totals, "standaloneFeesCents", trade.feesCents);
        break;
      case "tax":
        add(totals, "standaloneTaxesCents", taxAmount(trade));
        break;
      case "transfer": {
        const other = trade.transferTradeId === null ? undefined : byId.get(trade.transferTradeId);
        if (other !== undefined && other.accountId === trade.accountId) {
          // Between two portfolios of the same account: quantity only, both legs at once.
          if (other.type !== "transfer" || other.instrumentId !== trade.instrumentId || other.quantity !== -trade.quantity) {
            throw invalidTrade(trade, "transferTradeId", "the two legs of a transfer do not match");
          }
          const outgoing = trade.quantity < 0 ? trade : other;
          const incoming = trade.quantity < 0 ? other : trade;
          const source = requireQuantity(state, outgoing.portfolioId, outgoing, incoming.quantity);
          changeQuantity(state, source, outgoing.quantity);
          changeQuantity(state, portfolioOf(state, incoming.portfolioId), incoming.quantity);
          done.add(other.id);
        } else if (trade.quantity < 0) {
          // Out to another account: its proportional cost leaves, no gain.
          const moved = -trade.quantity;
          requireQuantity(state, trade.portfolioId, trade, moved);
          const removed = proportionalCost(state.cost, moved as Quantity, state.quantity);
          state.cost = plus(state.cost, -removed, "costBasisCents");
          changeQuantity(state, portfolio, trade.quantity);
          add(totals, "costTransferredOutCents", removed);
        } else {
          // In from another account: the units bring their own cost.
          if (trade.costBasisCents === null) {
            throw invalidTrade(trade, "costBasisCents", "a transfer in from another account needs its cost");
          }
          state.cost = plus(state.cost, trade.costBasisCents, "costBasisCents");
          changeQuantity(state, portfolio, trade.quantity);
          add(totals, "costInCents", trade.costBasisCents);
        }
        break;
      }
    }
  }
  return state;
}

/** A tax trade's amount: positive when paid, negative for a gain tax adjustment (money back). */
function taxAmount(trade: PositionTrade): Cents {
  return trade.taxKind === "gain_tax_adjustment" ? -trade.grossCents : trade.grossCents;
}

/**
 * Splits `cost` across `shares` in proportion to their quantities, rounding
 * each part down and handing the leftover minor units to the largest
 * remainders (ties to the smaller id), so the parts add up to `cost` exactly.
 */
function splitByQuantity(cost: Cents, shares: readonly (readonly [string, Quantity])[]): Map<string, Cents> {
  const result = new Map<string, Cents>(shares.map(([id]) => [id, 0]));
  const total = shares.reduce((sum, [, quantity]) => sum + BigInt(quantity), 0n);
  if (total === 0n) return result;
  const sign = cost < 0 ? -1n : 1n;
  const magnitude = BigInt(cost) * sign;
  let leftover = magnitude;
  const parts = shares.map(([id, quantity]) => {
    const product = magnitude * BigInt(quantity);
    const floor = product / total;
    leftover -= floor;
    return { id, floor, remainder: product % total };
  });
  parts.sort((a, b) => (a.remainder === b.remainder ? compareIds(a.id, b.id) : a.remainder > b.remainder ? -1 : 1));
  for (const part of parts) {
    const extra = leftover > 0n ? 1n : 0n;
    leftover -= extra;
    result.set(part.id, Number((part.floor + extra) * sign));
  }
  return result;
}

function averageCostOf(cost: Cents, quantity: Quantity, priceFactor: PriceFactor, currency: CurrencyCode): Price | null {
  return quantity === 0 ? null : priceFrom(cost, quantity, priceFactor, currency);
}

function groupKey(accountId: string, id: string): string {
  return JSON.stringify([accountId, id]);
}

/**
 * Computes every position of the given trades, per account and instrument
 * and per portfolio, by replaying each account and instrument's trades in the
 * fixed order. The result does not depend on the order of `trades`.
 *
 * Pass every trade of each account and instrument involved: a partial history
 * gives a wrong position. The outgoing leg of a transfer is matched with its
 * other leg when both are given; a leg whose other leg is missing or in
 * another account counts as a transfer between accounts.
 *
 * @throws ValidationError "insufficient_quantity" if a portfolio's quantity
 *   would go negative at any point (details: tradeId, accountId, portfolioId,
 *   instrumentId, date, available, requested, quantities in units × 10^8);
 *   "split_missing_for_portfolio" if a portfolio holds the instrument at the
 *   start of a split's date but has no split row for it (details: accountId,
 *   portfolioId, instrumentId, date); "split_leaves_no_quantity" if a split
 *   rounds a whole position with a cost down to zero units; "invalid_trade"
 *   (details: tradeId, field) for a trade that breaks the shape of its type;
 *   "invalid_date", "invalid_amount", "invalid_quantity", "invalid_price",
 *   "invalid_price_factor" for malformed values.
 */
export function computePositions(trades: readonly PositionTrade[]): Positions {
  const byId = new Map<string, PositionTrade>();
  const groups = new Map<string, { accountId: string; instrumentId: string; trades: SortableTrade[] }>();
  const charges = new Map<string, { accountId: string; portfolioId: string; currency: CurrencyCode; totals: MutableTotals }>();

  for (const trade of trades) {
    checkTrade(trade);
    if (byId.has(trade.id)) throw invalidTrade(trade, "id", "appears twice");
    byId.set(trade.id, trade);
    const sortable: SortableTrade = {
      trade,
      occurredMs: timestampOf(trade.occurredAt, "occurredAt"),
      createdMs: timestampOf(trade.createdAt, "createdAt"),
    };
    if (trade.instrumentId === null) {
      const key = groupKey(trade.accountId, trade.portfolioId);
      let charge = charges.get(key);
      if (charge === undefined) {
        charge = { accountId: trade.accountId, portfolioId: trade.portfolioId, currency: trade.currency, totals: emptyTotals() };
        charges.set(key, charge);
      }
      if (trade.currency !== charge.currency) throw invalidTrade(trade, "currency", "differs from the account's currency");
      if (trade.type === "fee") add(charge.totals, "standaloneFeesCents", trade.feesCents);
      else add(charge.totals, "standaloneTaxesCents", taxAmount(trade));
      continue;
    }
    const key = groupKey(trade.accountId, trade.instrumentId);
    let group = groups.get(key);
    if (group === undefined) {
      group = { accountId: trade.accountId, instrumentId: trade.instrumentId, trades: [] };
      groups.set(key, group);
    }
    group.trades.push(sortable);
  }

  const accounts: AccountPosition[] = [];
  const portfolios: PortfolioPosition[] = [];
  const orderedGroups = [...groups.values()].sort(
    (a, b) => compareIds(a.accountId, b.accountId) || compareIds(a.instrumentId, b.instrumentId),
  );
  for (const group of orderedGroups) {
    const sorted = group.trades.sort(compareReplay).map((s) => s.trade);
    const state = replay(group.accountId, group.instrumentId, sorted, byId);
    const averageCost = averageCostOf(state.cost, state.quantity, state.priceFactor, state.currency);
    const portfolioIds = [...state.portfolios.keys()].sort(compareIds);
    const costs = splitByQuantity(
      state.cost,
      portfolioIds.map((id) => [id, (state.portfolios.get(id) as PortfolioState).quantity] as const),
    );
    const accountTotals = emptyTotals();
    for (const portfolioId of portfolioIds) {
      const portfolio = state.portfolios.get(portfolioId) as PortfolioState;
      addAll(accountTotals, portfolio.totals);
      portfolios.push({
        portfolioId,
        accountId: state.accountId,
        instrumentId: state.instrumentId,
        currency: state.currency,
        priceFactor: state.priceFactor,
        quantity: portfolio.quantity,
        costBasisCents: costs.get(portfolioId) ?? 0,
        averageCost: portfolio.quantity === 0 ? null : averageCost,
        ...pickTotals(portfolio.totals),
      });
    }
    accounts.push({
      accountId: state.accountId,
      instrumentId: state.instrumentId,
      currency: state.currency,
      priceFactor: state.priceFactor,
      quantity: state.quantity,
      costBasisCents: state.cost,
      averageCost,
      ...accountTotals,
    });
  }

  const orderedCharges = [...charges.values()]
    .sort((a, b) => compareIds(a.accountId, b.accountId) || compareIds(a.portfolioId, b.portfolioId))
    .map((charge) => ({
      accountId: charge.accountId,
      portfolioId: charge.portfolioId,
      currency: charge.currency,
      standaloneFeesCents: charge.totals.standaloneFeesCents,
      standaloneTaxesCents: charge.totals.standaloneTaxesCents,
    }));

  return { accounts, portfolios, charges: orderedCharges };
}

/**
 * Checks that a trade history can be replayed: no portfolio's quantity ever
 * goes negative, every split covers every portfolio holding the instrument.
 * The API calls it with an account and instrument's whole history as it
 * would be after a change (see `applyTradeChanges`).
 *
 * @throws the same ValidationErrors as `computePositions`.
 */
export function validatePositionHistory(trades: readonly PositionTrade[]): void {
  computePositions(trades);
}

/**
 * The history as it would be after inserting, editing or deleting trades,
 * applied in order, to pass to `validatePositionHistory` before writing them.
 *
 * @throws ValidationError "unknown_trade" (details: tradeId) when an edit or
 *   a deletion names a trade not in the history; "invalid_trade" when an
 *   insert reuses an id.
 */
export function applyTradeChanges(history: readonly PositionTrade[], changes: readonly TradeChange[]): PositionTrade[] {
  const result = [...history];
  for (const change of changes) {
    const id = change.kind === "delete" ? change.tradeId : change.trade.id;
    const index = result.findIndex((trade) => trade.id === id);
    if (change.kind === "insert") {
      if (index !== -1) throw invalidTrade(change.trade, "id", "is already in the history");
      result.push(change.trade);
      continue;
    }
    if (index === -1) throw new ValidationError("unknown_trade", `trade ${id} is not in the history`, { tradeId: id });
    if (change.kind === "update") result[index] = change.trade;
    else result.splice(index, 1);
  }
  return result;
}

/**
 * The value of a position at `price` (`amountOf` its whole quantity, rounded
 * once, ADR 0011) and its unrealized gain or loss: value − cost.
 */
export function valuePosition(
  position: Pick<AccountPosition, "quantity" | "costBasisCents" | "priceFactor" | "currency">,
  price: Price,
): { readonly valueCents: Cents; readonly unrealizedCents: Cents } {
  const valueCents = amountOf(position.quantity, price, position.priceFactor, position.currency);
  return { valueCents, unrealizedCents: plus(valueCents, -position.costBasisCents, "unrealized") };
}

// --- Aggregation --------------------------------------------------------------

function summarize<K extends string>(
  rows: readonly (PositionTotals & { readonly currency: CurrencyCode; readonly costBasisCents: Cents; readonly key: K })[],
  charges: readonly (AccountCharge & { readonly key: K })[],
): { key: K; summary: PositionSummary }[] {
  const byKey = new Map<string, { key: K; currency: CurrencyCode; cost: Cents; totals: MutableTotals }>();
  const entry = (key: K, currency: CurrencyCode) => {
    const id = JSON.stringify([key, currency]);
    let found = byKey.get(id);
    if (found === undefined) {
      found = { key, currency, cost: 0, totals: emptyTotals() };
      byKey.set(id, found);
    }
    return found;
  };
  for (const row of rows) {
    const found = entry(row.key, row.currency);
    found.cost = plus(found.cost, row.costBasisCents, "costBasisCents");
    addAll(found.totals, row);
  }
  for (const charge of charges) {
    const found = entry(charge.key, charge.currency);
    add(found.totals, "standaloneFeesCents", charge.standaloneFeesCents);
    add(found.totals, "standaloneTaxesCents", charge.standaloneTaxesCents);
  }
  return [...byKey.values()]
    .sort((a, b) => compareIds(a.key, b.key) || compareIds(a.currency, b.currency))
    .map(({ key, currency, cost, totals }) => ({ key, summary: { currency, costBasisCents: cost, ...totals } }));
}

/**
 * Totals per portfolio, across its instruments and accounts, including its
 * fees and taxes recorded without an instrument. A portfolio spanning
 * accounts in different currencies gets one row per currency: amounts in
 * different currencies are never added together. Sorted by portfolio, then
 * currency.
 */
export function summarizeByPortfolio(positions: Positions): PortfolioSummary[] {
  return summarize(
    positions.portfolios.map((row) => ({ ...row, key: row.portfolioId })),
    positions.charges.map((charge) => ({ ...charge, key: charge.portfolioId })),
  ).map(({ key, summary }) => ({ portfolioId: key, ...summary }));
}

/**
 * Totals per account, across its instruments and portfolios, including its
 * fees and taxes recorded without an instrument. Sorted by account.
 */
export function summarizeByAccount(positions: Positions): AccountSummary[] {
  return summarize(
    positions.accounts.map((row) => ({ ...row, key: row.accountId })),
    positions.charges.map((charge) => ({ ...charge, key: charge.accountId })),
  ).map(({ key, summary }) => ({ accountId: key, ...summary }));
}
