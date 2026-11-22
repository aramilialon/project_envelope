/**
 * The external flows of a portfolio, derived from its trades (design.md,
 * "Portfolio module"; domain guide, "Flows, valuation and returns").
 *
 * A portfolio holds securities only: the cash of its trades belongs to the
 * account. Money moved into the portfolio is a positive flow, money taken out
 * a negative one:
 *
 * | Trade | Flow |
 * | --- | --- |
 * | buy | + everything it cost: gross + fees + transaction tax + accrued interest − domestic withholding credited |
 * | sell | − the net proceeds |
 * | dividend or coupon | − the net cash (kind "income") |
 * | fee, tax | + the amount; a gain tax refund is − |
 * | transfer of securities | ± the market value of the units moved on its date (never their cost), + its fees |
 * | split | none |
 *
 * That is, every flow is minus the trade's cash leg (`tradeCashCents`), plus
 * the market value of the securities a transfer moves in (+) or out (−).
 * Returns computed from these flows are after costs and taxes.
 *
 * Pure: no database and no user-facing text (ADR 0004).
 */

import { ValidationError } from "../errors.ts";
import type { Cents, CurrencyCode } from "../money.ts";
import { assertCents } from "../money.ts";
import type { LocalDate } from "../month.ts";
import type { PositionTrade } from "./positions.ts";
import type { Price } from "./quantity.ts";
import { amountOf } from "./quantity.ts";
import type { ExternalFlow } from "./returns.ts";
import { tradeCashCents } from "./trades.ts";

/**
 * What a flow is: "income" for the net cash of a dividend or a coupon, which
 * leaves the portfolio as a return on it; "contribution" for everything else
 * (money put in or taken out, fees, taxes, securities moved).
 */
export type ExternalFlowKind = "contribution" | "income";

/** One trade's flow, in the trade's (the account's) currency. */
export interface TradeFlow extends ExternalFlow {
  readonly tradeId: string;
  readonly kind: ExternalFlowKind;
  /** The account's currency: the caller converts each flow at its own date's rate. */
  readonly currency: CurrencyCode;
}

/**
 * The price of an instrument on a date, as `Price` in the account's currency
 * (the latest price on or before `date`), or null when there is none.
 */
export type PriceLookup = (instrumentId: string, date: LocalDate) => Price | null;

/**
 * The flow of each trade, in the order given, splits left out. A transfer's
 * flow is null (unknown, never 0) when `priceOf` has no price for its
 * instrument on its date.
 *
 * @throws ValidationError "invalid_trade" (details: tradeId, field
 *   "instrumentId") for a transfer with no instrument; "invalid_amount" for
 *   an amount that is not a safe integer.
 */
export function externalFlows(trades: readonly PositionTrade[], priceOf: PriceLookup): TradeFlow[] {
  const flows: TradeFlow[] = [];
  for (const trade of trades) {
    if (trade.type === "split") continue;
    // 0 − x, never −x: a zero cash leg stays 0, not -0.
    const cashIn = 0 - tradeCashCents(trade);
    let amountCents: Cents | null = cashIn;
    if (trade.type === "transfer") {
      if (trade.instrumentId === null) {
        throw new ValidationError("invalid_trade", `trade ${trade.id}: a transfer needs an instrument`, {
          tradeId: trade.id,
          field: "instrumentId",
        });
      }
      const price = priceOf(trade.instrumentId, trade.date);
      if (price === null) {
        amountCents = null;
      } else {
        const value = amountOf(Math.abs(trade.quantity) as PositionTrade["quantity"], price, trade.priceFactor, trade.currency);
        const signed = trade.quantity < 0 ? 0 - value : value;
        amountCents = signed + cashIn;
        assertCents(amountCents, "flow");
      }
    }
    flows.push({
      tradeId: trade.id,
      date: trade.date,
      amountCents,
      kind: trade.type === "dividend" ? "income" : "contribution",
      currency: trade.currency,
    });
  }
  return flows;
}
