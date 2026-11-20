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
import type { LocalDate } from "../month.ts";
import type { TaxRegime, TaxRegimeEntry } from "./tax-regime.ts";
import { regimeAt } from "./tax-regime.ts";

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
 *     withholding of a bond buy or sale exceeds its accrued interest;
 *   - "invalid_trade" (details: field) for a fee of 0, a tax of 0 or less, or
 *     a gain tax adjustment of 0: a trade that moves nothing is not recorded.
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

  if (trade.type === "fee" && trade.feesCents <= 0) {
    throw new ValidationError("invalid_trade", "a fee needs a positive amount", { field: "feesCents" });
  }
  if (trade.type === "tax" && (trade.taxKind === "gain_tax_adjustment" ? trade.grossCents === 0 : trade.grossCents <= 0)) {
    throw new ValidationError("invalid_trade", "a tax needs a non-zero amount", { field: "grossCents" });
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

/** What the regime check needs to know about the account and the instrument of a trade. */
export interface TradeRegimeContext {
  /** The account's regime history (`regimeAt` picks the one in force on a date). */
  readonly history: readonly TaxRegimeEntry[];
  /** The trade date. */
  readonly date: LocalDate;
  /** Whether the broker is a domestic (Italian) withholding agent. */
  readonly domesticWithholdingAgent: boolean | null;
  /** The instrument's type, or null for a fee or a tax without one. */
  readonly instrumentType: InstrumentType | null;
}

/**
 * Whether gain tax can be withheld under `regime`: by the broker in `administered`; in
 * `self_declared` only on a `fund` at a domestic withholding agent, which still withholds on fund
 * gains; never in `managed`, where the mandate settles the tax on its result.
 */
function gainTaxAllowed(regime: TaxRegime, context: TradeRegimeContext): boolean {
  if (regime === "administered") return true;
  if (regime === "self_declared") return context.instrumentType === "fund" && context.domesticWithholdingAgent === true;
  return false;
}

/**
 * Checks a trade on a brokerage account of an `IT` workspace against the account's tax regime
 * history (#508). Outside such a workspace there is no regime, and nothing to check.
 *
 * - Gain tax on a sale needs a regime that allows it on the sale's date (`gainTaxAllowed`).
 * - A gain tax adjustment corrects gain tax withheld earlier, possibly under an earlier regime (an
 *   administered sale in December, a switch to self-declared from 1 January, a refund in
 *   February), so it is allowed when any regime in force on or before its date allows gain tax.
 *   In `self_declared` that means it names the fund it adjusts.
 * - `managed_result_tax` exists only in `managed`.
 * - The domestic withholding on the accrued interest of a bond buy or sale is computed only by a
 *   domestic withholding agent. A dividend's or a coupon's domestic withholding may have been taken
 *   upstream, before a foreign broker paid it, so any broker can carry it.
 *
 * @throws ValidationError "tax_kind_not_allowed_in_regime" (details: regime, field — "gainTaxCents"
 *   or "taxKind" —, and taxKind for a tax); "domestic_withholding_requires_agent" (details: field).
 */
export function checkTradeRegime(trade: TradeAmounts, context: TradeRegimeContext): void {
  const regime = regimeAt(context.history, context.date);
  if (regime === undefined) {
    throw new ValidationError("tax_regime_required", "the account has no tax regime", {});
  }
  const refuse = (field: string): never => {
    throw new ValidationError("tax_kind_not_allowed_in_regime", `the ${regime} regime does not allow this ${field}`, {
      regime,
      field,
      ...(trade.taxKind === null ? {} : { taxKind: trade.taxKind }),
    });
  };

  if (trade.type === "sell" && trade.gainTaxCents !== 0 && !gainTaxAllowed(regime, context)) {
    refuse("gainTaxCents");
  }
  if (trade.type === "tax" && trade.taxKind === "gain_tax_adjustment") {
    // Every regime in force on or before the date: each period that started by then, and the
    // first period, which also covers earlier dates.
    const regimes = new Set<TaxRegime>([regime, ...context.history.filter((entry) => entry.validFrom <= context.date).map((entry) => entry.regime)]);
    if (![...regimes].some((candidate) => gainTaxAllowed(candidate, context))) refuse("taxKind");
  }
  if (trade.type === "tax" && trade.taxKind === "managed_result_tax" && regime !== "managed") {
    refuse("taxKind");
  }

  if ((trade.type === "buy" || trade.type === "sell") && trade.withholdingDomesticCents !== 0 && context.domesticWithholdingAgent !== true) {
    throw new ValidationError(
      "domestic_withholding_requires_agent",
      "only a domestic withholding agent withholds tax on the accrued interest of a bond trade",
      { field: "withholdingDomesticCents" },
    );
  }
}
