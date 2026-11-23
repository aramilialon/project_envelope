/**
 * A portfolio's monthly performance (#89; design.md, "Portfolio module"; ADR 0019), computed on
 * every request by `@envelope/core`'s `monthlyPerformance`: never stored, never cached. This
 * module only loads what the core needs, under the request's Row-Level Security:
 *
 * - the workspace's whole history of every instrument the portfolio has a trade of, and the
 *   portfolio's fees and taxes without an instrument (`loadPositionTrades`, as for positions);
 * - each of those instruments' prices, the workspace's own and the shared ones, up to the last
 *   date valued (`loadPriceCandidates`: the precedence is the core's);
 * - the stored rates of every currency involved, up to the same date (`loadFxRates`).
 *
 * Nothing here calls a market-data provider (ADR 0019).
 */
import { assertPerformanceRange, lastDayOfMonth, monthlyPerformance, type PortfolioPerformance } from "@envelope/core";

import type { DbClient } from "../db/pool.ts";
import { loadFxRates } from "../market-data/fx-rates-repository.ts";
import { loadPriceCandidates } from "../prices/repository.ts";
import { loadPositionTrades } from "../trades/repository.ts";

/** The workspace's base currency and today in its own time zone. */
async function workspaceContext(db: DbClient, workspaceId: string): Promise<{ baseCurrency: string; today: string }> {
  const { rows } = await db.query<{ base_currency: string; today: string }>(
    "SELECT base_currency, to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS today FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`workspaceContext: workspace "${workspaceId}" not found`);
  }
  return { baseCurrency: row.base_currency, today: row.today };
}

/**
 * The portfolio's performance for each month from `from` to `to` (`YYYY-MM`), and over the
 * range. The range is checked before anything else is loaded.
 *
 * @throws ValidationError `invalid_month` (details: field, value, and `max` for a `to` after the
 *   current month) or `range_too_long` (details: months, max), from `assertPerformanceRange`.
 */
export async function portfolioPerformance(
  db: DbClient,
  workspaceId: string,
  portfolioId: string,
  from: unknown,
  to: unknown,
): Promise<PortfolioPerformance> {
  const { baseCurrency, today } = await workspaceContext(db, workspaceId);
  assertPerformanceRange(from, to, today);
  const fromMonth = from as string;
  const toMonth = to as string;
  const last = lastDayOfMonth(toMonth);
  const upTo = last > today ? today : last;

  const trades = await loadPositionTrades(db, workspaceId, { portfolioId });
  const instrumentIds = [...new Set(trades.flatMap((trade) => (trade.instrumentId === null ? [] : [trade.instrumentId])))];
  const priceCandidates = await loadPriceCandidates(db, workspaceId, instrumentIds, upTo);
  const fxRates = await loadFxRates(db, [baseCurrency, ...trades.map((trade) => trade.currency)], upTo);

  return monthlyPerformance({ portfolioId, trades, priceCandidates, fxRates, baseCurrency, from: fromMonth, to: toMonth, today });
}
