/**
 * Rules for entering a trade, on top of the shape `computePositions` checks
 * (design.md, "Portfolio module"; ADR 0012).
 *
 * - `tradeCashCents` is the cash a trade moves on its account, the amount of
 *   its cash leg (ADR 0012): positive is cash into the account.
 * - `checkTradeEntry` checks what the user typed against the instrument,
 *   before the history is replayed. The broker's figures are authoritative:
 *   no amount is ever compared with an estimate of it.
 *
 * Pure: no database and no user-facing text, only `ValidationError`s with a
 * stable code (ADR 0004).
 */

import { ValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import { assertCents } from "../money.ts";
import type { InstrumentType } from "./instrument.ts";
import type { PositionTrade } from "./positions.ts";

/** Instrument types that pay accrued interest when they change hands. */
const INTEREST_BEARING: ReadonlySet<InstrumentType> = new Set<InstrumentType>(["government_bond", "bond"]);

const AMOUNT_FIELDS = [
  "grossCents",
  "feesCents",
  "transactionTaxCents",
  "accruedInterestCents",
  "withholdingForeignCents",
  "withholdingDomesticCents",
  "gainTaxCents",
] as const;

type TradeAmounts = Pick<
  PositionTrade,
  "type" | "taxKind" | "costBasisCents" | (typeof AMOUNT_FIELDS)[number]
>;

/** Adds amounts, checking that every partial sum stays a safe integer. */
function sum(...amounts: readonly Cents[]): Cents {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    assertCents(total, "cash");
  }
  return total;
}

/**
 * The cash a trade moves on its account, in the account's minor unit:
 * positive is cash into the account, negative cash out (ADR 0012).
 *
 * | Type | Cash |
 * | --- | --- |
 * | buy | −(gross + fees + transaction tax + accrued interest − domestic withholding) |
 * | sell | gross + accrued interest − fees − transaction tax − gain tax − domestic withholding |
 * | dividend | gross − fees − foreign withholding − domestic withholding |
 * | fee | −fees |
 * | tax | −gross; +gross for a gain tax adjustment (positive is a refund) |
 * | transfer | −fees |
 * | split | 0 |
 *
 * @throws ValidationError "invalid_amount" if an amount or a partial sum is not a safe integer.
 */
export function tradeCashCents(trade: TradeAmounts): Cents {
  for (const field of AMOUNT_FIELDS) assertCents(trade[field], field);
  switch (trade.type) {
    case "buy":
      // 0 − x, never −x: a zero amount stays 0, not -0.
      return 0 - sum(
        trade.grossCents,
        trade.feesCents,
        trade.transactionTaxCents,
        trade.accruedInterestCents,
        -trade.withholdingDomesticCents,
      );
    case "sell":
      return sum(
        trade.grossCents,
        trade.accruedInterestCents,
        -trade.feesCents,
        -trade.transactionTaxCents,
        -trade.gainTaxCents,
        -trade.withholdingDomesticCents,
      );
    case "dividend":
      return sum(trade.grossCents, -trade.feesCents, -trade.withholdingForeignCents, -trade.withholdingDomesticCents);
    case "fee":
      return 0 - trade.feesCents;
    case "tax":
      return trade.taxKind === "gain_tax_adjustment" ? trade.grossCents : 0 - trade.grossCents;
    case "transfer":
      return 0 - trade.feesCents;
    case "split":
      return 0;
  }
}

/**
 * Checks a trade being entered against the rules that do not need its
 * history; `validatePositionHistory` checks the rest.
 *
 * @param instrumentType the type of the trade's instrument, or null for a
 *   fee or a tax without one.
 * @throws ValidationError
 *   - "negative_amount_not_allowed" (details: field) for a negative amount or
 *     cost; only a gain tax adjustment's gross may be negative (extra tax);
 *   - "tax_kind_not_allowed_for_trade_type" (details: type, taxKind) for a
 *     tax kind on anything but a tax;
 *   - "accrued_interest_not_allowed" (details: instrumentType) for accrued
 *     interest on an instrument that is not a bond;
 *   - "withholding_exceeds_gross" (details: field — "withholding" for a
 *     dividend's two withholdings together —, withheld, gross) when the
 *     withholdings of a dividend exceed its gross, or the domestic
 *     withholding of a bond buy or sale exceeds its accrued interest.
 */
export function checkTradeEntry(trade: TradeAmounts, instrumentType: InstrumentType | null): void {
  for (const field of AMOUNT_FIELDS) {
    const value = trade[field];
    assertCents(value, field);
    const signed = field === "grossCents" && trade.type === "tax" && trade.taxKind === "gain_tax_adjustment";
    if (value < 0 && !signed) {
      throw new ValidationError("negative_amount_not_allowed", `${field} cannot be negative`, { field });
    }
  }
  if (trade.costBasisCents !== null) {
    assertCents(trade.costBasisCents, "costBasisCents");
    if (trade.costBasisCents < 0) {
      throw new ValidationError("negative_amount_not_allowed", "costBasisCents cannot be negative", { field: "costBasisCents" });
    }
  }

  if (trade.taxKind !== null && trade.type !== "tax") {
    throw new ValidationError("tax_kind_not_allowed_for_trade_type", `a ${trade.type} has no tax kind`, {
      type: trade.type,
      taxKind: trade.taxKind,
    });
  }

  if (trade.accruedInterestCents !== 0 && (instrumentType === null || !INTEREST_BEARING.has(instrumentType))) {
    throw new ValidationError("accrued_interest_not_allowed", "only a bond trade carries accrued interest", {
      instrumentType: instrumentType ?? "",
    });
  }

  if (trade.type === "dividend") {
    const withheld = sum(trade.withholdingForeignCents, trade.withholdingDomesticCents);
    if (withheld > trade.grossCents) {
      throw new ValidationError("withholding_exceeds_gross", "the withholdings exceed the gross income", {
        field: "withholding",
        withheld,
        gross: trade.grossCents,
      });
    }
  } else if ((trade.type === "buy" || trade.type === "sell") && trade.withholdingDomesticCents > trade.accruedInterestCents) {
    throw new ValidationError("withholding_exceeds_gross", "the domestic withholding exceeds the accrued interest", {
      field: "withholdingDomesticCents",
      withheld: trade.withholdingDomesticCents,
      gross: trade.accruedInterestCents,
    });
  }
}
