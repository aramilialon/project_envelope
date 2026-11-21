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
import { assertAmount, assertCents } from "../money.ts";
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
 *     a gain tax adjustment of 0: a trade that moves nothing is not recorded;
 *   - "amount_too_large" (details: label — the field, or "cash" for the cash
 *     the trade moves —, max, value) for an amount, a cost or a cash leg
 *     beyond `MAX_AMOUNT_CENTS` (ADR 0002).
 */
export function checkTradeEntry(trade: TradeAmounts, instrumentType: InstrumentType | null): void {
  for (const field of AMOUNT_FIELDS) {
    const value = trade[field];
    assertAmount(value, field);
    const signed = field === "grossCents" && trade.type === "tax" && trade.taxKind === "gain_tax_adjustment";
    if (value < 0 && !signed) {
      throw new ValidationError("negative_amount_not_allowed", `${field} cannot be negative`, { field });
    }
  }
  if (trade.costBasisCents !== null) {
    assertAmount(trade.costBasisCents, "costBasisCents");
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

  // The cash leg is a transaction of its own (ADR 0012): capped like any other amount written.
  assertAmount(tradeCashCents(trade), "cash");
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
  checkTaxKindsInRegime(trade, context);
  if ((trade.type === "buy" || trade.type === "sell") && trade.withholdingDomesticCents !== 0 && context.domesticWithholdingAgent !== true) {
    throw new ValidationError(
      "domestic_withholding_requires_agent",
      "only a domestic withholding agent withholds tax on the accrued interest of a bond trade",
      { field: "withholdingDomesticCents" },
    );
  }
}

/** The rules of `checkTradeRegime` that depend on the regime history. */
function checkTaxKindsInRegime(trade: TradeAmounts, context: TradeRegimeContext): void {
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
    if (![...regimesUpTo(context.history, context.date)].some((candidate) => gainTaxAllowed(candidate, context))) refuse("taxKind");
  }
  if (trade.type === "tax" && trade.taxKind === "managed_result_tax" && regime !== "managed") {
    refuse("taxKind");
  }
}

/**
 * Every regime in force on or before `date`: each period that started by then, and the first
 * period, which also covers earlier dates. Empty only for an empty history.
 */
function regimesUpTo(history: readonly TaxRegimeEntry[], date: LocalDate): Set<TaxRegime> {
  const regimes = new Set<TaxRegime>(history.filter((entry) => entry.validFrom <= date).map((entry) => entry.regime));
  const regime = regimeAt(history, date);
  if (regime !== undefined) regimes.add(regime);
  return regimes;
}

/** A stored trade, as `checkRegimeChange` reads it again. */
export interface RegimeCheckedTrade extends TradeAmounts {
  readonly id: string;
  /** The trade date. */
  readonly date: LocalDate;
  /** The instrument's type, or null for a fee or a tax without one. */
  readonly instrumentType: InstrumentType | null;
}

/** A change to an account's regime history, as `checkRegimeChange` judges it. */
export interface RegimeChange {
  /** The history as stored before the change; empty when the account has none yet. */
  readonly before: readonly TaxRegimeEntry[];
  /** The whole history once the change is applied. */
  readonly after: readonly TaxRegimeEntry[];
  /** Whether the broker is a domestic (Italian) withholding agent. */
  readonly domesticWithholdingAgent: boolean | null;
}

/**
 * Reads an account's trades again once its regime history changes (#653). Every trade the change
 * covers — its date now falls under another regime or, for a gain tax adjustment, the regimes in
 * force on or before its date are no longer the same — is checked against the new history by the
 * rules of `checkTradeRegime` that depend on the regime. A trade the change does not cover is not
 * judged again, and neither is the domestic-withholding rule, which depends on the broker alone.
 *
 * The account's first regime (an empty history before the change) covers every trade, and every
 * trade is checked by the whole of `checkTradeRegime`, the domestic-withholding rule included
 * (`checkAccountTradesAgainstRegime`): a trade entered while the account had no regime was never
 * checked against the broker either.
 *
 * @throws ValidationError "tax_regime_conflicts_with_trade" (details: tradeId, tradeDate, and code,
 *   the trade's own failing code, such as "tax_kind_not_allowed_in_regime") for the first trade,
 *   by date then id, that the new history would break.
 */
export function checkRegimeChange(trades: readonly RegimeCheckedTrade[], change: RegimeChange): void {
  if (change.before.length === 0) {
    checkAccountTradesAgainstRegime(trades, { history: change.after, domesticWithholdingAgent: change.domesticWithholdingAgent });
    return;
  }
  for (const trade of byDateThenId(trades)) {
    if (!coveredByChange(trade, change)) continue;
    asTradeConflict(trade, () =>
      checkTaxKindsInRegime(trade, {
        history: change.after,
        date: trade.date,
        domesticWithholdingAgent: change.domesticWithholdingAgent,
        instrumentType: trade.instrumentType,
      }),
    );
  }
}

/** An account's regime history and broker, as `checkAccountTradesAgainstRegime` judges its trades. */
export interface AccountRegime {
  /** The account's whole regime history. */
  readonly history: readonly TaxRegimeEntry[];
  /** Whether the broker is a domestic (Italian) withholding agent. */
  readonly domesticWithholdingAgent: boolean | null;
}

/**
 * Checks every trade of an account by the whole of `checkTradeRegime` (#653): when the account
 * gets its first regime, and when its withholding-agent flag is set while it has a regime history.
 *
 * @throws ValidationError "tax_regime_conflicts_with_trade" (details: tradeId, tradeDate, code) for
 *   the first trade, by date then id, that breaks a rule.
 */
export function checkAccountTradesAgainstRegime(trades: readonly RegimeCheckedTrade[], account: AccountRegime): void {
  for (const trade of byDateThenId(trades)) {
    asTradeConflict(trade, () =>
      checkTradeRegime(trade, {
        history: account.history,
        date: trade.date,
        domesticWithholdingAgent: account.domesticWithholdingAgent,
        instrumentType: trade.instrumentType,
      }),
    );
  }
}

function byDateThenId(trades: readonly RegimeCheckedTrade[]): RegimeCheckedTrade[] {
  return [...trades].sort((a, b) => compareText(a.date, b.date) || compareText(a.id, b.id));
}

/** Runs `check`, turning the trade's own `ValidationError` into "tax_regime_conflicts_with_trade". */
function asTradeConflict(trade: RegimeCheckedTrade, check: () => void): void {
  try {
    check();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    throw new ValidationError("tax_regime_conflicts_with_trade", `the regime breaks the trade ${trade.id} of ${trade.date}`, {
      tradeId: trade.id,
      tradeDate: trade.date,
      code: error.code,
    });
  }
}

/** Whether the regimes that judge `trade` differ between the two histories. */
function coveredByChange(trade: RegimeCheckedTrade, change: RegimeChange): boolean {
  if (trade.type === "tax" && trade.taxKind === "gain_tax_adjustment") {
    const before = regimesUpTo(change.before, trade.date);
    const after = regimesUpTo(change.after, trade.date);
    return before.size !== after.size || [...after].some((regime) => !before.has(regime));
  }
  return regimeAt(change.before, trade.date) !== regimeAt(change.after, trade.date);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
