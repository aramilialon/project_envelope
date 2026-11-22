/**
 * The common interface of every market-data source (#84, ADR 0019; design.md, "Market data").
 *
 * A provider fetches public data, the same for every workspace: closing prices of shared
 * instruments and euro exchange rates. What it returns is written as shared rows by a queue job,
 * never during a request: screens and endpoints read only what is stored, and never call a
 * provider. A provider implements only what it can fetch; one with neither method (`manual`)
 * fetches nothing, and prices then come only from manual entry and CSV imports.
 *
 * Every method takes an `AbortSignal`, which the job sets to its time limit: a provider passes it
 * on to every request it makes, so a source that stops answering never holds a job forever.
 */
import type { FxRate, LocalDate } from "@envelope/core";

/** The shared instruments to fetch prices for, and the days wanted. */
export interface PricesRequest {
  readonly instruments: readonly {
    readonly id: string;
    readonly isin: string | null;
    readonly ticker: string | null;
    readonly exchange: string | null;
    readonly currency: string;
  }[];
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/** One closing price, quoted like a trade's `price_e6` (ADR 0011). */
export interface FetchedPrice {
  readonly instrumentId: string;
  readonly date: LocalDate;
  readonly closeE6: number;
}

/** The rates wanted: every day after `since` (the newest day already stored), or every day there is when it is null. */
export interface FxRatesRequest {
  readonly since: LocalDate | null;
}

export interface MarketDataProvider {
  /** The provider's name, stored with what it fetched (`prices.provider`, `fx_rates.source`). */
  readonly id: string;
  fetchPrices?(request: PricesRequest, signal: AbortSignal): Promise<readonly FetchedPrice[]>;
  /** May return days already stored as well: the job writes only what is new or changed. */
  fetchFxRates?(request: FxRatesRequest, signal: AbortSignal): Promise<readonly FxRate[]>;
}
