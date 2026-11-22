/**
 * The `manual` price provider (#84): it fetches nothing. Prices then come only from what users
 * enter or import into their own workspace (#83), which the read path already loads; no shared
 * price is ever written. The default, and the only price provider until one that needs a user's
 * key or a licence is added (design.md, "Market data").
 */
import type { MarketDataProvider } from "./provider.ts";

export const MANUAL_PROVIDER_ID = "manual";

export function createManualProvider(): MarketDataProvider {
  return { id: MANUAL_PROVIDER_ID };
}
