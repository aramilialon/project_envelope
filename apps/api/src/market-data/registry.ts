/**
 * The price providers the server can use, by the name `MARKET_DATA_PRICE_PROVIDER` gives
 * (#84). `config.ts` refuses any other name at startup, so a typo never leaves the server
 * running without the source its administrator meant; this is the one place that maps a name to
 * an adapter.
 */
import { createManualProvider, MANUAL_PROVIDER_ID } from "./manual-provider.ts";
import type { MarketDataProvider } from "./provider.ts";

export const PRICE_PROVIDER_NAMES = [MANUAL_PROVIDER_ID] as const;

export type PriceProviderName = (typeof PRICE_PROVIDER_NAMES)[number];

export function isPriceProviderName(value: string): value is PriceProviderName {
  return (PRICE_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function createPriceProvider(name: PriceProviderName): MarketDataProvider {
  switch (name) {
    case MANUAL_PROVIDER_ID:
      return createManualProvider();
  }
}
