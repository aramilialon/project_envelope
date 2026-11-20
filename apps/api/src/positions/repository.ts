/**
 * Positions of a portfolio or an account (#79; design.md, "Portfolio module"; ADR 0011), rebuilt
 * on every request by `@envelope/core`'s `computePositions`: never stored.
 *
 * The cost is per account and instrument, shared by every portfolio of the account, and a transfer
 * between two accounts carries it from one to the other, so the replay always takes the
 * workspace's whole history of each instrument involved, other portfolios' and accounts' trades
 * included (`loadPositionTrades`); only then are the rows of the portfolio or account asked for
 * kept. A portfolio gets its own quantity, its share of the account's cost, the account's average
 * cost and the totals of its own trades.
 *
 * No prices exist yet (milestone 0.2.1): no current value, no unrealized gain and no net result.
 */
import {
  computePositions,
  derivedResults,
  summarizeByAccount,
  summarizeByPortfolio,
  type AccountPosition,
  type DerivedResults,
  type PortfolioPosition,
  type PositionSummary,
  type PositionTotals,
  type Positions,
} from "@envelope/core";

import type { DbClient } from "../db/pool.ts";
import { getInstruments, type Instrument } from "../instruments/repository.ts";
import { loadPositionTrades } from "../trades/repository.ts";

/** One position as the API returns it: per account and instrument, with the instrument's catalog fields. */
export interface PositionRecord extends PositionTotals, DerivedResults {
  readonly accountId: string;
  readonly instrument: Instrument;
  /** The account's currency: every amount below is in it. */
  readonly currency: string;
  /** Units × 10^8. Zero for a position sold out, kept for its totals. */
  readonly quantityE8: number;
  /**
   * For a portfolio, its share of the account's cost, split by quantity. Never divide it by the
   * portfolio's quantity: show `accountAverageCostE6`.
   */
  readonly costBasisCents: number;
  /**
   * The account's average cost × 10^6 in the instrument's price unit: C ÷ (Q × price factor), half
   * to even at 6 decimals (a bond in percent of nominal, a share quoted in pence in pence), shared by
   * every portfolio of the account, for display only; null when nothing is held.
   */
  readonly accountAverageCostE6: number | null;
}

export interface SummaryRecord extends PositionTotals, DerivedResults {
  readonly currency: string;
  readonly costBasisCents: number;
}

export interface PositionsResult {
  /** Sorted by account, then instrument id. */
  readonly positions: PositionRecord[];
  /** One per currency, sorted by currency: amounts in different currencies are never added together. */
  readonly summaries: SummaryRecord[];
}

/**
 * Every total of a position, by name: the compiler checks this list against `PositionTotals`, so a
 * total added to the core cannot be left out of the response.
 */
const TOTALS: Readonly<Record<keyof PositionTotals, true>> = {
  realizedCents: true,
  costInCents: true,
  costSoldCents: true,
  costTransferredOutCents: true,
  tradeFeesCents: true,
  incomeFeesCents: true,
  transferFeesCents: true,
  transactionTaxCents: true,
  accruedInterestPaidCents: true,
  accruedInterestReceivedCents: true,
  gainTaxWithheldCents: true,
  gainTaxAdjustmentsCents: true,
  managedResultTaxCents: true,
  incomeGrossCents: true,
  withholdingForeignCents: true,
  withholdingDomesticCents: true,
  standaloneFeesCents: true,
  standaloneTaxesCents: true,
};

/** The totals of a row, then the domain guide's income, costs and taxes on gains worked out from them. */
function totalsOf(row: PositionTotals): PositionTotals & DerivedResults {
  const totals: Partial<Record<keyof PositionTotals, number>> = {};
  for (const key of Object.keys(TOTALS) as (keyof PositionTotals)[]) {
    totals[key] = row[key];
  }
  return { ...(totals as PositionTotals), ...derivedResults(row) };
}

async function toRecords(db: DbClient, rows: readonly (AccountPosition | PortfolioPosition)[]): Promise<PositionRecord[]> {
  const instruments = await getInstruments(db, [...new Set(rows.map((row) => row.instrumentId))]);
  return rows.map((row) => {
    const instrument = instruments.get(row.instrumentId);
    if (!instrument) {
      // Trades reference the catalog with ON DELETE RESTRICT: this cannot happen.
      throw new Error(`instrument ${row.instrumentId} of a trade is not in the catalog`);
    }
    return {
      accountId: row.accountId,
      instrument,
      currency: row.currency,
      quantityE8: row.quantity,
      costBasisCents: row.costBasisCents,
      accountAverageCostE6: row.averageCost,
      ...totalsOf(row),
    };
  });
}

/** A summary without its portfolio or account id: the route's path already names it. */
function summaryOf(summary: PositionSummary): SummaryRecord {
  return { currency: summary.currency, costBasisCents: summary.costBasisCents, ...totalsOf(summary) };
}

/**
 * A portfolio's positions, one per account and instrument it has ever had a trade of, and its
 * totals per currency, including its fees and taxes recorded without an instrument.
 */
export async function portfolioPositions(db: DbClient, workspaceId: string, portfolioId: string): Promise<PositionsResult> {
  const all = computePositions(await loadPositionTrades(db, workspaceId, { portfolioId }));
  const own: Positions = {
    accounts: [],
    portfolios: all.portfolios.filter((row) => row.portfolioId === portfolioId),
    charges: all.charges.filter((charge) => charge.portfolioId === portfolioId),
  };
  return {
    positions: await toRecords(db, own.portfolios),
    summaries: summarizeByPortfolio(own).map(summaryOf),
  };
}

/**
 * An account's positions, one per instrument it has ever had a trade of, across its portfolios,
 * and its totals per currency, including its fees and taxes recorded without an instrument. An
 * account with no trades (any account that is not a brokerage account) has none.
 */
export async function accountPositions(db: DbClient, workspaceId: string, accountId: string): Promise<PositionsResult> {
  const all = computePositions(await loadPositionTrades(db, workspaceId, { accountId }));
  const own: Positions = {
    accounts: all.accounts.filter((row) => row.accountId === accountId),
    portfolios: [],
    charges: all.charges.filter((charge) => charge.accountId === accountId),
  };
  return {
    positions: await toRecords(db, own.accounts),
    summaries: summarizeByAccount(own).map(summaryOf),
  };
}
