/**
 * Positions computed from trades (design.md, "Portfolio module"; ADR 0011).
 *
 * A position is never stored: it is rebuilt by replaying the trades in a
 * fixed order, so every rebuild gives the same result to the cent and to the
 * 10^-8 unit. All the trades of one instrument in a workspace are replayed
 * together, because a transfer between two accounts carries the cost the
 * outgoing leg removes into the receiving account.
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
 *   - transfer between two accounts: the outgoing leg removes its
 *     proportional cost and the incoming leg adds exactly that cost, no gain;
 *     an incoming transfer from outside the app (no outgoing leg) adds the
 *     cost it carries; a transfer's fees are their own total, never cost;
 *     between two portfolios of the same account: quantity only;
 *   - split (on its ex-date): each portfolio's quantity × to ÷ from, toward
 *     zero to 8 decimals, C unchanged, no gain;
 *   - dividends, coupons, standalone fees and taxes: C unchanged.
 * - A split affects every holding: every portfolio holding the instrument at
 *   the start of the split's date, in any account, needs its own split row.
 * - Replay order: `(date, split first, occurredAt, createdAt, id)`. `date` is
 *   the trade date on the broker's statement; a split applies at the start of
 *   its date, before every other trade of that date. Timestamps are compared
 *   to the millisecond; ties fall to the next key.
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
const TAX_KINDS: ReadonlySet<string> = new Set<TaxKind>(["stamp_duty", "managed_result_tax", "gain_tax_adjustment", "other"]);

/**
 * One trade, as the replay needs it: the columns of the `trades` table plus
 * the two values the caller joins in (`currency`, `priceFactor`). Every
 * `*Cents` is in the account's currency. An amount, quantity or price a type
 * does not use is 0; `taxKind`, `costBasisCents`, `splitFrom`, `splitTo` and
 * `transferTradeId` are null when not used.
 */
export interface PositionTrade {
  readonly id: string;
  readonly accountId: string;
  readonly portfolioId: string;
  /** Null only for an account-wide fee or tax. */
  readonly instrumentId: string | null;
  readonly type: TradeType;
  /** The trade date as on the broker's statement; a split's is its ex-date. */
  readonly date: LocalDate;
  /**
   * When the trade happened, as a strict ISO 8601 timestamp with `Z` or an
   * offset: orders trades within the same date, to the millisecond.
   */
  readonly occurredAt: string;
  /** When the trade was recorded, same format: breaks ties of `occurredAt`. */
  readonly createdAt: string;
  /** The account's currency. */
  readonly currency: CurrencyCode;
  /**
   * Units × 10^8. Positive on a buy and a sell (the type gives the
   * direction); on a transfer, negative on the outgoing leg and positive on
   * the incoming one; 0 on every other type.
   */
  readonly quantity: Quantity;
  /** The price of a buy or a sell; 0 on every other type. */
  readonly price: Price;
  /** The instrument's price factor. */
  readonly priceFactor: PriceFactor;
  /** Buy and sell: the amount of the units; dividend: the gross income; tax: the tax amount. */
  readonly grossCents: Cents;
  readonly feesCents: Cents;
  readonly transactionTaxCents: Cents;
  readonly accruedInterestCents: Cents;
  readonly withholdingForeignCents: Cents;
  /**
   * Dividend: withheld (≥ 0). Bond buy or sell with accrued interest: signed,
   * as in the cash leg (a buy's is credited back, a sell's is withheld).
   */
  readonly withholdingDomesticCents: Cents;
  readonly gainTaxCents: Cents;
  /** Required on a tax, null otherwise. */
  readonly taxKind: TaxKind | null;
  /** Only on an incoming transfer from outside the app (no other leg): the cost the units bring. */
  readonly costBasisCents: Cents | null;
  readonly splitFrom: number | null;
  readonly splitTo: number | null;
  /** The other leg of a transfer; null for a transfer from or to outside the app. */
  readonly transferTradeId: string | null;
}

/** Running totals of a position, each in the account's minor unit. */
export interface PositionTotals {
  /** Gains (positive) and losses (negative) realized by sales: economic, not taxable. */
  readonly realizedCents: Cents;
  /** Cost that entered the position: buys (gross + fees) and transfers in. */
  readonly costInCents: Cents;
  /** Cost removed by sales. */
  readonly costSoldCents: Cents;
  /** Cost carried out by transfers to another account or outside the app. */
  readonly costTransferredOutCents: Cents;
  /** Fees of buys and sells: informational, already inside the cost and the gain. */
  readonly tradeFeesCents: Cents;
  /** Fees of dividends and coupons, to subtract from income. */
  readonly incomeFeesCents: Cents;
  /** Fees of transfers of securities: never part of the cost. */
  readonly transferFeesCents: Cents;
  /** Transaction taxes (the financial transaction tax and similar), never part of the cost. */
  readonly transactionTaxCents: Cents;
  /** Accrued interest paid on buys, never part of the cost. */
  readonly accruedInterestPaidCents: Cents;
  /** Accrued interest received on sells, never part of the gain. */
  readonly accruedInterestReceivedCents: Cents;
  /**
   * Gain tax withheld on sales, net of gain tax adjustments: an adjustment's
   * positive amount (a refund) lowers it, a negative one (extra tax) raises it.
   */
  readonly gainTaxCents: Cents;
  /** Dividends and coupons, gross. */
  readonly dividendsCents: Cents;
  readonly withholdingForeignCents: Cents;
  /**
   * Domestic withholding net of credits: a dividend's and a sell's count as
   * withheld, a bond buy's (credited back with the accrued interest paid)
   * counts negative.
   */
  readonly withholdingDomesticCents: Cents;
  /** Fee trades. */
  readonly standaloneFeesCents: Cents;
  /** Tax trades other than gain tax adjustments. */
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
  readonly standaloneTaxesCents: Cents;
  /** Gain tax adjustments without an instrument: a refund counts negative. */
  readonly gainTaxCents: Cents;
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
  "tradeFeesCents",
  "incomeFeesCents",
  "transferFeesCents",
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

const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Milliseconds since the epoch of a strict ISO 8601 timestamp with `Z` or an
 * offset, or null if it is anything else. Digits beyond the millisecond are
 * accepted and ignored.
 */
function strictTimestamp(value: string): number | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return null;
  const [, date, hours, minutes, seconds, , offsetHours, offsetMinutes] = match;
  try {
    assertDate(date as string);
  } catch {
    return null;
  }
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  if (offsetHours !== undefined && (Number(offsetHours) > 23 || Number(offsetMinutes) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function timestampOf(trade: PositionTrade, field: "occurredAt" | "createdAt"): number {
  const ms = strictTimestamp(trade[field]);
  if (ms === null) throw invalidTrade(trade, field, `not an ISO 8601 timestamp with an offset: "${trade[field]}"`);
  return ms;
}

const AMOUNT_FIELDS = [
  "grossCents",
  "feesCents",
  "transactionTaxCents",
  "accruedInterestCents",
  "withholdingForeignCents",
  "withholdingDomesticCents",
  "gainTaxCents",
] as const;

type AmountField = (typeof AMOUNT_FIELDS)[number];

/** The amounts each type uses; every other amount must be 0. */
const USED_AMOUNTS: Readonly<Record<TradeType, readonly AmountField[]>> = {
  buy: ["grossCents", "feesCents", "transactionTaxCents", "accruedInterestCents", "withholdingDomesticCents"],
  sell: ["grossCents", "feesCents", "transactionTaxCents", "accruedInterestCents", "withholdingDomesticCents", "gainTaxCents"],
  dividend: ["grossCents", "feesCents", "withholdingForeignCents", "withholdingDomesticCents"],
  fee: ["feesCents"],
  tax: ["grossCents"],
  split: [],
  transfer: ["feesCents"],
};

/** Whether an amount may be negative: a bond trade's domestic withholding, a gain tax adjustment. */
function signedAllowed(trade: PositionTrade, field: AmountField): boolean {
  if (field === "withholdingDomesticCents") return trade.type === "buy" || trade.type === "sell";
  if (field === "grossCents") return trade.type === "tax" && trade.taxKind === "gain_tax_adjustment";
  return false;
}

function checkTrade(trade: PositionTrade): void {
  if (!TRADE_TYPES.has(trade.type)) throw invalidTrade(trade, "type", `unknown type "${String(trade.type)}"`);
  assertDate(trade.date);
  assertQuantity(trade.quantity);
  assertPrice(trade.price);
  assertPriceFactor(trade.priceFactor);

  const used = USED_AMOUNTS[trade.type];
  for (const field of AMOUNT_FIELDS) {
    const value = trade[field];
    assertCents(value, field);
    if (!used.includes(field)) {
      if (value !== 0) throw invalidTrade(trade, field, `a ${trade.type} does not use ${field}`);
    } else if (value < 0 && !signedAllowed(trade, field)) {
      throw invalidTrade(trade, field, `${field} cannot be negative`);
    }
  }
  if ((trade.type === "buy" || trade.type === "sell") && trade.withholdingDomesticCents !== 0 && trade.accruedInterestCents === 0) {
    throw invalidTrade(trade, "withholdingDomesticCents", "only a trade with accrued interest has a domestic withholding");
  }

  if (trade.instrumentId === null && trade.type !== "fee" && trade.type !== "tax") {
    throw invalidTrade(trade, "instrumentId", `a ${trade.type} needs an instrument`);
  }
  if (trade.type === "buy" || trade.type === "sell") {
    if (trade.quantity <= 0) throw invalidTrade(trade, "quantity", `a ${trade.type} needs a positive quantity`);
  } else {
    if (trade.price !== 0) throw invalidTrade(trade, "price", `a ${trade.type} does not use a price`);
    if (trade.type === "transfer") {
      if (trade.quantity === 0) throw invalidTrade(trade, "quantity", "a transfer needs a non-zero quantity");
    } else if (trade.quantity !== 0) {
      throw invalidTrade(trade, "quantity", `a ${trade.type} does not use a quantity`);
    }
  }

  if (trade.type === "tax") {
    if (trade.taxKind === null || !TAX_KINDS.has(trade.taxKind)) throw invalidTrade(trade, "taxKind", "a tax needs a kind");
  } else if (trade.taxKind !== null) {
    throw invalidTrade(trade, "taxKind", `a ${trade.type} has no tax kind`);
  }

  for (const field of ["splitFrom", "splitTo"] as const) {
    const value = trade[field];
    if (trade.type === "split") {
      if (value === null || !Number.isSafeInteger(value) || value <= 0) {
        throw invalidTrade(trade, field, "a split needs a ratio of two positive integers");
      }
    } else if (value !== null) {
      throw invalidTrade(trade, field, `a ${trade.type} has no split ratio`);
    }
  }

  if (trade.type !== "transfer" && trade.transferTradeId !== null) {
    throw invalidTrade(trade, "transferTradeId", `a ${trade.type} has no other leg`);
  }
  const fromOutside = trade.type === "transfer" && trade.transferTradeId === null && trade.quantity > 0;
  if (fromOutside) {
    if (trade.costBasisCents === null) {
      throw invalidTrade(trade, "costBasisCents", "a transfer in from outside the app needs its cost");
    }
    assertCents(trade.costBasisCents, "costBasisCents");
    if (trade.costBasisCents < 0) throw invalidTrade(trade, "costBasisCents", "costBasisCents cannot be negative");
  } else if (trade.costBasisCents !== null) {
    throw invalidTrade(trade, "costBasisCents", "only a transfer in from outside the app carries a cost");
  }
}

/** Checks that two transfer legs belong together: linked both ways, equal and opposite, same time. */
function checkLegs(trade: PositionTrade, other: PositionTrade | undefined): PositionTrade {
  if (other === undefined) throw invalidTrade(trade, "transferTradeId", "the other leg of the transfer is missing");
  if (other.type !== "transfer" || other.transferTradeId !== trade.id || other.instrumentId !== trade.instrumentId) {
    throw invalidTrade(trade, "transferTradeId", "the other leg is not a transfer of the same instrument linked back");
  }
  if (other.quantity !== -trade.quantity) {
    throw invalidTrade(trade, "quantity", "the two legs of a transfer need equal and opposite quantities");
  }
  if (other.date !== trade.date) throw invalidTrade(trade, "date", "the two legs of a transfer need the same date");
  if (strictTimestamp(other.occurredAt) !== strictTimestamp(trade.occurredAt)) {
    throw invalidTrade(trade, "occurredAt", "the two legs of a transfer need the same time");
  }
  return other;
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

/** The position of one account in the instrument being replayed. */
interface AccountState {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly currency: CurrencyCode;
  readonly priceFactor: PriceFactor;
  quantity: Quantity;
  cost: Cents;
  readonly portfolios: Map<string, PortfolioState>;
}

function portfolioOf(state: AccountState, portfolioId: string): PortfolioState {
  let portfolio = state.portfolios.get(portfolioId);
  if (portfolio === undefined) {
    portfolio = { quantity: 0 as Quantity, totals: emptyTotals() };
    state.portfolios.set(portfolioId, portfolio);
  }
  return portfolio;
}

function changeQuantity(state: AccountState, portfolio: PortfolioState, delta: number): void {
  portfolio.quantity = toQuantity(portfolio.quantity + delta);
  state.quantity = toQuantity(state.quantity + delta);
}

function requireQuantity(state: AccountState, trade: PositionTrade, requested: number): PortfolioState {
  const portfolio = portfolioOf(state, trade.portfolioId);
  if (requested > portfolio.quantity) {
    throw new ValidationError(
      "insufficient_quantity",
      `portfolio ${trade.portfolioId} holds ${portfolio.quantity} of instrument ${state.instrumentId} on ${trade.date}, not ${requested} (units × 10^8)`,
      {
        tradeId: trade.id,
        accountId: state.accountId,
        portfolioId: trade.portfolioId,
        instrumentId: state.instrumentId,
        date: trade.date,
        available: portfolio.quantity,
        requested,
      },
    );
  }
  return portfolio;
}

/** Removes the proportional cost of `moved` units from an account, returning it. */
function removeCost(state: AccountState, moved: Quantity): Cents {
  const removed = proportionalCost(state.cost, moved, state.quantity);
  state.cost = plus(state.cost, -removed, "costBasisCents");
  return removed;
}

/**
 * Applies the split rows of one account on a split's date. `splits` may be
 * empty: a split affects every holding, so an account holding the instrument
 * without any split row on that date is rejected too.
 */
function applySplits(state: AccountState, date: LocalDate, splits: readonly PositionTrade[]): void {
  const where = { accountId: state.accountId, instrumentId: state.instrumentId, date };
  const covered = new Set<string>();
  for (const split of splits) {
    if (covered.has(split.portfolioId)) {
      throw new ValidationError("split_duplicate", `portfolio ${split.portfolioId} has two split rows on ${date}`, {
        ...where,
        portfolioId: split.portfolioId,
      });
    }
    covered.add(split.portfolioId);
    const first = splits[0] as PositionTrade;
    // Same ratio: from₁ × to₂ = from₂ × to₁ (ratios checked positive by checkTrade).
    if (BigInt(split.splitFrom ?? 1) * BigInt(first.splitTo ?? 1) !== BigInt(first.splitFrom ?? 1) * BigInt(split.splitTo ?? 1)) {
      throw new ValidationError(
        "split_ratio_mismatch",
        `the split rows of instrument ${state.instrumentId} on ${date} have different ratios`,
        where,
      );
    }
  }
  const missing = [...state.portfolios.entries()]
    .filter(([id, portfolio]) => portfolio.quantity > 0 && !covered.has(id))
    .map(([id]) => id)
    .sort(compareIds)[0];
  if (missing !== undefined) {
    throw new ValidationError(
      "split_missing_for_portfolio",
      `portfolio ${missing} holds instrument ${state.instrumentId} on ${date} but has no split row`,
      { ...where, portfolioId: missing },
    );
  }
  for (const split of splits) {
    const portfolio = portfolioOf(state, split.portfolioId);
    // Toward zero, to 8 decimals.
    const scaled = (BigInt(portfolio.quantity) * BigInt(split.splitTo ?? 1)) / BigInt(split.splitFrom ?? 1);
    changeQuantity(state, portfolio, toQuantity(Number(scaled)) - portfolio.quantity);
  }
  if (state.quantity === 0 && state.cost !== 0) {
    throw new ValidationError(
      "split_leaves_no_quantity",
      `the split on ${date} rounds the whole position in instrument ${state.instrumentId} down to zero`,
      where,
    );
  }
}

/** A tax trade's effect: [total, amount]; gain tax adjustments net into the gain tax. */
function taxEffect(trade: PositionTrade): ["gainTaxCents" | "standaloneTaxesCents", Cents] {
  return trade.taxKind === "gain_tax_adjustment" ? ["gainTaxCents", -trade.grossCents] : ["standaloneTaxesCents", trade.grossCents];
}

/** Replays every account's trades of one instrument, already sorted. */
function replayInstrument(
  instrumentId: string,
  sorted: readonly PositionTrade[],
  byId: ReadonlyMap<string, PositionTrade>,
): Map<string, AccountState> {
  const accounts = new Map<string, AccountState>();
  const accountOf = (trade: PositionTrade): AccountState => {
    let state = accounts.get(trade.accountId);
    if (state === undefined) {
      state = {
        accountId: trade.accountId,
        instrumentId,
        currency: trade.currency,
        priceFactor: trade.priceFactor,
        quantity: 0 as Quantity,
        cost: 0,
        portfolios: new Map(),
      };
      accounts.set(trade.accountId, state);
    }
    if (trade.currency !== state.currency) throw invalidTrade(trade, "currency", "differs from the account's currency");
    if (trade.priceFactor !== state.priceFactor) {
      throw invalidTrade(trade, "priceFactor", "differs from the instrument's price factor");
    }
    return state;
  };
  const done = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const trade = sorted[i] as PositionTrade;
    if (done.has(trade.id)) continue;

    if (trade.type === "split") {
      // Every split row of this date (they sort first), applied per account. Every account
      // already holding the instrument is checked, rows or not: a split affects every holding.
      const byAccount = new Map<string, PositionTrade[]>();
      for (let j = i; j < sorted.length; j++) {
        const other = sorted[j] as PositionTrade;
        if (other.type !== "split" || other.date !== trade.date) break;
        const rows = byAccount.get(other.accountId) ?? [];
        rows.push(other);
        byAccount.set(other.accountId, rows);
        done.add(other.id);
      }
      const accountIds = new Set([...accounts.keys(), ...byAccount.keys()]);
      for (const accountId of [...accountIds].sort(compareIds)) {
        const rows = byAccount.get(accountId) ?? [];
        const state = rows[0] === undefined ? (accounts.get(accountId) as AccountState) : accountOf(rows[0]);
        applySplits(state, trade.date, rows);
      }
      continue;
    }

    const state = accountOf(trade);
    const portfolio = portfolioOf(state, trade.portfolioId);
    const totals = portfolio.totals;
    switch (trade.type) {
      case "buy": {
        const cost = plus(trade.grossCents, trade.feesCents, "cost");
        state.cost = plus(state.cost, cost, "costBasisCents");
        changeQuantity(state, portfolio, trade.quantity);
        add(totals, "costInCents", cost);
        add(totals, "tradeFeesCents", trade.feesCents);
        add(totals, "transactionTaxCents", trade.transactionTaxCents);
        add(totals, "accruedInterestPaidCents", trade.accruedInterestCents);
        // Credited back with the accrued interest paid: a negative withholding.
        add(totals, "withholdingDomesticCents", -trade.withholdingDomesticCents);
        break;
      }
      case "sell": {
        requireQuantity(state, trade, trade.quantity);
        const removed = removeCost(state, trade.quantity);
        changeQuantity(state, portfolio, -trade.quantity);
        const proceeds = plus(trade.grossCents, -trade.feesCents, "proceeds");
        add(totals, "realizedCents", plus(proceeds, -removed, "realized"));
        add(totals, "costSoldCents", removed);
        add(totals, "tradeFeesCents", trade.feesCents);
        add(totals, "transactionTaxCents", trade.transactionTaxCents);
        add(totals, "accruedInterestReceivedCents", trade.accruedInterestCents);
        add(totals, "gainTaxCents", trade.gainTaxCents);
        add(totals, "withholdingDomesticCents", trade.withholdingDomesticCents);
        break;
      }
      case "dividend":
        add(totals, "dividendsCents", trade.grossCents);
        add(totals, "incomeFeesCents", trade.feesCents);
        add(totals, "withholdingForeignCents", trade.withholdingForeignCents);
        add(totals, "withholdingDomesticCents", trade.withholdingDomesticCents);
        break;
      case "fee":
        add(totals, "standaloneFeesCents", trade.feesCents);
        break;
      case "tax":
        add(totals, ...taxEffect(trade));
        break;
      case "transfer": {
        if (trade.transferTradeId === null) {
          add(totals, "transferFeesCents", trade.feesCents);
          if (trade.quantity < 0) {
            // Out of the app: its proportional cost leaves, no gain.
            const moved = -trade.quantity as Quantity;
            requireQuantity(state, trade, moved);
            add(totals, "costTransferredOutCents", removeCost(state, moved));
            changeQuantity(state, portfolio, trade.quantity);
          } else {
            // In from outside the app: the units bring the cost they carry.
            const cost = trade.costBasisCents ?? 0;
            state.cost = plus(state.cost, cost, "costBasisCents");
            add(totals, "costInCents", cost);
            changeQuantity(state, portfolio, trade.quantity);
          }
          break;
        }
        const other = checkLegs(trade, byId.get(trade.transferTradeId));
        checkLegs(other, trade);
        done.add(other.id);
        const outgoing = trade.quantity < 0 ? trade : other;
        const incoming = trade.quantity < 0 ? other : trade;
        const source = accountOf(outgoing);
        const target = accountOf(incoming);
        const sourcePortfolio = requireQuantity(source, outgoing, incoming.quantity);
        const targetPortfolio = portfolioOf(target, incoming.portfolioId);
        add(sourcePortfolio.totals, "transferFeesCents", outgoing.feesCents);
        add(targetPortfolio.totals, "transferFeesCents", incoming.feesCents);
        if (source !== target) {
          // Between two accounts: the cost the outgoing leg removes is the cost the incoming one adds.
          const removed = removeCost(source, incoming.quantity);
          add(sourcePortfolio.totals, "costTransferredOutCents", removed);
          target.cost = plus(target.cost, removed, "costBasisCents");
          add(targetPortfolio.totals, "costInCents", removed);
        }
        changeQuantity(source, sourcePortfolio, outgoing.quantity);
        changeQuantity(target, targetPortfolio, incoming.quantity);
        break;
      }
    }
  }
  return accounts;
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

/**
 * Computes every position of the given trades, per account and instrument
 * and per portfolio, by replaying each instrument's trades across all
 * accounts in the fixed order. The result does not depend on the order of
 * `trades`.
 *
 * Pass every trade of each instrument involved, in every account of the
 * workspace: a transfer between two accounts needs both legs, and a partial
 * history gives a wrong position.
 *
 * @throws ValidationError "insufficient_quantity" if a portfolio's quantity
 *   would go negative at any point (details: tradeId, accountId, portfolioId,
 *   instrumentId, date, available, requested, quantities in units × 10^8);
 *   "split_missing_for_portfolio" if a portfolio, in any account, holds the
 *   instrument at the start of a split's date but has no split row for it, "split_duplicate"
 *   for two split rows of one portfolio on one date, "split_ratio_mismatch"
 *   for split rows of one account and date with different ratios (details:
 *   accountId, instrumentId, date, and portfolioId where one is concerned);
 *   "split_leaves_no_quantity" if a split rounds a whole position with a cost
 *   down to zero units; "invalid_trade" (details: tradeId, field) for a trade
 *   that breaks the shape of its type or a transfer whose legs do not match;
 *   "invalid_date", "invalid_amount", "invalid_quantity", "invalid_price",
 *   "invalid_price_factor" for malformed values.
 */
export function computePositions(trades: readonly PositionTrade[]): Positions {
  const byId = new Map<string, PositionTrade>();
  const instruments = new Map<string, SortableTrade[]>();
  const charges = new Map<string, { accountId: string; portfolioId: string; currency: CurrencyCode; totals: MutableTotals }>();

  for (const trade of trades) {
    checkTrade(trade);
    if (byId.has(trade.id)) throw invalidTrade(trade, "id", "appears twice");
    byId.set(trade.id, trade);
    const sortable: SortableTrade = {
      trade,
      occurredMs: timestampOf(trade, "occurredAt"),
      createdMs: timestampOf(trade, "createdAt"),
    };
    if (trade.instrumentId === null) {
      const key = JSON.stringify([trade.accountId, trade.portfolioId]);
      let charge = charges.get(key);
      if (charge === undefined) {
        charge = { accountId: trade.accountId, portfolioId: trade.portfolioId, currency: trade.currency, totals: emptyTotals() };
        charges.set(key, charge);
      }
      if (trade.currency !== charge.currency) throw invalidTrade(trade, "currency", "differs from the account's currency");
      if (trade.type === "fee") add(charge.totals, "standaloneFeesCents", trade.feesCents);
      else add(charge.totals, ...taxEffect(trade));
      continue;
    }
    const group = instruments.get(trade.instrumentId) ?? [];
    group.push(sortable);
    instruments.set(trade.instrumentId, group);
  }

  const states: AccountState[] = [];
  for (const [instrumentId, group] of instruments) {
    const sorted = group.sort(compareReplay).map((s) => s.trade);
    states.push(...replayInstrument(instrumentId, sorted, byId).values());
  }
  states.sort((a, b) => compareIds(a.accountId, b.accountId) || compareIds(a.instrumentId, b.instrumentId));

  const accounts: AccountPosition[] = [];
  const portfolios: PortfolioPosition[] = [];
  for (const state of states) {
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
      gainTaxCents: charge.totals.gainTaxCents,
    }));

  return { accounts, portfolios, charges: orderedCharges };
}

/**
 * Checks that a trade history can be replayed: every trade has the shape of
 * its type, no portfolio's quantity ever goes negative, every split covers
 * every portfolio holding the instrument, every transfer's legs match. The
 * API calls it with the workspace's whole history of each instrument a
 * change touches, as it would be after the change (see `applyTradeChanges`).
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
    add(found.totals, "gainTaxCents", charge.gainTaxCents);
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
