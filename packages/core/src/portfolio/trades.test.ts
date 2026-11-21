import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { MAX_AMOUNT_CENTS } from "../money.ts";
import type { PositionTrade } from "./positions.ts";
import type { Price, Quantity } from "./quantity.ts";
import { amountOf, PRICE_FACTOR_HUNDREDTH } from "./quantity.ts";
import { checkAccountTradesAgainstRegime, checkRegimeChange, checkTradeEntry, checkTradeRegime, tradeCashCents } from "./trades.ts";
import type { RegimeCheckedTrade } from "./trades.ts";

type Amounts = Pick<
  PositionTrade,
  | "type"
  | "taxKind"
  | "costBasisCents"
  | "grossCents"
  | "feesCents"
  | "transactionTaxCents"
  | "accruedInterestCents"
  | "withholdingForeignCents"
  | "withholdingDomesticCents"
  | "gainTaxCents"
>;

function amounts(fields: Partial<Amounts> & Pick<Amounts, "type">): Amounts {
  return {
    taxKind: null,
    costBasisCents: null,
    grossCents: 0,
    feesCents: 0,
    transactionTaxCents: 0,
    accruedInterestCents: 0,
    withholdingForeignCents: 0,
    withholdingDomesticCents: 0,
    gainTaxCents: 0,
    ...fields,
  };
}

describe("tradeCashCents (ADR 0012)", () => {
  it("takes gross, fees, transaction tax and accrued interest out on a buy, and credits the domestic withholding back", () => {
    const cash = tradeCashCents(
      amounts({ type: "buy", grossCents: 987_654, feesCents: 500, transactionTaxCents: 100, accruedInterestCents: 2_000, withholdingDomesticCents: 250 }),
    );
    assert.equal(cash, -(987_654 + 500 + 100 + 2_000 - 250));
  });

  it("puts gross and accrued interest in on a sell, less fees, taxes and withholding", () => {
    const cash = tradeCashCents(
      amounts({
        type: "sell",
        grossCents: 420_000,
        accruedInterestCents: 1_000,
        feesCents: 500,
        transactionTaxCents: 50,
        gainTaxCents: 24_726,
        withholdingDomesticCents: 125,
      }),
    );
    assert.equal(cash, 420_000 + 1_000 - 500 - 50 - 24_726 - 125);
  });

  it("puts a dividend's net in", () => {
    // design.md's worked example: €20.00 gross, €3.00 foreign, €4.42 domestic withholding, €2.00 fee.
    const cash = tradeCashCents(
      amounts({ type: "dividend", grossCents: 2_000, withholdingForeignCents: 300, withholdingDomesticCents: 442, feesCents: 200 }),
    );
    assert.equal(cash, 1_058);
  });

  it("takes a fee, a tax and a transfer's fees out", () => {
    assert.equal(tradeCashCents(amounts({ type: "fee", feesCents: 1_200 })), -1_200);
    assert.equal(tradeCashCents(amounts({ type: "tax", taxKind: "stamp_duty", grossCents: 3_400 })), -3_400);
    assert.equal(tradeCashCents(amounts({ type: "transfer", feesCents: 2_500 })), -2_500);
    assert.equal(tradeCashCents(amounts({ type: "transfer" })), 0);
  });

  it("puts a gain tax refund in and takes extra gain tax out", () => {
    assert.equal(tradeCashCents(amounts({ type: "tax", taxKind: "gain_tax_adjustment", grossCents: 10_000 })), 10_000);
    assert.equal(tradeCashCents(amounts({ type: "tax", taxKind: "gain_tax_adjustment", grossCents: -4_000 })), -4_000);
  });

  it("moves no cash on a split", () => {
    assert.equal(tradeCashCents(amounts({ type: "split" })), 0);
  });

  it("refuses a sum beyond the safe integer range", () => {
    assert.throws(
      () => tradeCashCents(amounts({ type: "buy", grossCents: Number.MAX_SAFE_INTEGER, feesCents: 1 })),
      (error) => isValidationError(error, "invalid_amount"),
    );
  });
});

describe("tradeCashCents, worked examples (domain expert)", () => {
  // A BTP paying a 2% coupon every six months, 10,000 nominal (the quantity) quoted in percent
  // (price factor 0.01).
  const nominal = (10_000 * 100_000_000) as Quantity;

  it("takes a bond buy's gross, fee and accrued interest out, net of the withholding credited back", () => {
    // Bought at 98.50, 60 days into a 182-day coupon period.
    const grossCents = amountOf(nominal, 98_500_000 as Price, PRICE_FACTOR_HUNDREDTH, "EUR");
    assert.equal(grossCents, 985_000);
    const buy = amounts({
      type: "buy",
      grossCents,
      feesCents: 500,
      accruedInterestCents: 6_593, // 10,000 × 2% × 60/182
      withholdingDomesticCents: 824, // 12.5% of it, credited back
    });
    assert.equal(tradeCashCents(buy), -(985_000 + 500 + 6_593 - 824));
    assert.equal(tradeCashCents(buy), -991_269);
  });

  it("puts a bond sale's gross and accrued interest in, net of fee, gain tax and withholding", () => {
    // Sold at 99.20: the €60 gain is taxed at 12.5%.
    const grossCents = amountOf(nominal, 99_200_000 as Price, PRICE_FACTOR_HUNDREDTH, "EUR");
    assert.equal(grossCents, 992_000);
    const sell = amounts({
      type: "sell",
      grossCents,
      accruedInterestCents: 13_187,
      feesCents: 500,
      gainTaxCents: 750,
      withholdingDomesticCents: 1_648, // 12.5% of the accrued interest
    });
    assert.equal(tradeCashCents(sell), 992_000 + 13_187 - 500 - 750 - 1_648);
    assert.equal(tradeCashCents(sell), 1_002_289);
  });

  it("puts a coupon in net of its domestic withholding", () => {
    // €200.00 gross on the nominal, €25.00 (12.5%) withheld.
    assert.equal(tradeCashCents(amounts({ type: "dividend", grossCents: 20_000, withholdingDomesticCents: 2_500 })), 17_500);
  });

  it("puts a foreign dividend in net of both withholdings and its fee", () => {
    // €100.00 gross, €15.00 withheld abroad, €22.10 domestic, a €2.00 fee.
    const dividend = amounts({ type: "dividend", grossCents: 10_000, withholdingForeignCents: 1_500, withholdingDomesticCents: 2_210, feesCents: 200 });
    assert.equal(tradeCashCents(dividend), 6_090);
  });
});

describe("checkTradeEntry", () => {
  it("refuses a fee of 0, a tax of 0 or less, and a gain tax adjustment of 0", () => {
    for (const [fields, field] of [
      [{ type: "fee" }, "feesCents"],
      [{ type: "tax", taxKind: "stamp_duty" }, "grossCents"],
      [{ type: "tax", taxKind: "gain_tax_adjustment" }, "grossCents"],
    ] as const) {
      assert.throws(
        () => checkTradeEntry(amounts(fields), null),
        (error) => isValidationError(error, "invalid_trade") && error.details.field === field,
        JSON.stringify(fields),
      );
    }
  });

  it("accepts an ordinary buy, a bond buy with accrued interest and a gain tax adjustment charging extra tax", () => {
    checkTradeEntry(amounts({ type: "buy", grossCents: 10_000, feesCents: 500 }), "fund");
    checkTradeEntry(amounts({ type: "buy", grossCents: 10_000, accruedInterestCents: 300, withholdingDomesticCents: 37 }), "government_bond");
    checkTradeEntry(amounts({ type: "tax", taxKind: "gain_tax_adjustment", grossCents: -500 }), null);
  });

  it("refuses a negative amount or cost, naming the field", () => {
    for (const [fields, field] of [
      [{ type: "buy", feesCents: -1 }, "feesCents"],
      [{ type: "dividend", grossCents: -100 }, "grossCents"],
      [{ type: "tax", taxKind: "stamp_duty", grossCents: -100 }, "grossCents"],
      [{ type: "sell", withholdingDomesticCents: -5, accruedInterestCents: 10 }, "withholdingDomesticCents"],
      [{ type: "transfer", costBasisCents: -1 }, "costBasisCents"],
    ] as const) {
      assert.throws(
        () => checkTradeEntry(amounts(fields), "bond"),
        (error) => isValidationError(error, "negative_amount_not_allowed") && error.details.field === field,
        JSON.stringify(fields),
      );
    }
  });

  it("refuses a tax kind on anything but a tax", () => {
    assert.throws(
      () => checkTradeEntry(amounts({ type: "fee", feesCents: 100, taxKind: "stamp_duty" }), null),
      (error) =>
        isValidationError(error, "tax_kind_not_allowed_for_trade_type") && error.details.type === "fee" && error.details.taxKind === "stamp_duty",
    );
  });

  it("refuses accrued interest on an instrument that is not a bond", () => {
    assert.throws(
      () => checkTradeEntry(amounts({ type: "buy", grossCents: 10_000, accruedInterestCents: 300 }), "stock"),
      (error) => isValidationError(error, "accrued_interest_not_allowed") && error.details.instrumentType === "stock",
    );
  });

  it("refuses withholdings above a dividend's gross, and a domestic withholding above a bond trade's accrued interest", () => {
    checkTradeEntry(amounts({ type: "dividend", grossCents: 1_000, withholdingForeignCents: 600, withholdingDomesticCents: 400 }), "stock");
    assert.throws(
      () => checkTradeEntry(amounts({ type: "dividend", grossCents: 1_000, withholdingForeignCents: 600, withholdingDomesticCents: 401 }), "stock"),
      (error) => isValidationError(error, "withholding_exceeds_gross") && error.details.withheld === 1_001 && error.details.gross === 1_000,
    );
    assert.throws(
      () => checkTradeEntry(amounts({ type: "sell", grossCents: 10_000, accruedInterestCents: 100, withholdingDomesticCents: 101 }), "bond"),
      (error) => isValidationError(error, "withholding_exceeds_gross") && error.details.field === "withholdingDomesticCents",
    );
  });
});

describe("checkTradeRegime (#508)", () => {
  type Regime = "self_declared" | "administered" | "managed";
  const regimeError = (field: string) => (error: unknown) =>
    isValidationError(error, "tax_kind_not_allowed_in_regime") && error.details.field === field;
  const sellWithGainTax = amounts({ type: "sell", grossCents: 10_000, gainTaxCents: 260 });
  const refund = amounts({ type: "tax", taxKind: "gain_tax_adjustment", grossCents: 100 });
  /** One regime since 2020, on 2026-06-01. */
  const context = (regime: Regime, domesticWithholdingAgent: boolean | null, instrumentType: "fund" | "stock" | "bond" | null) => ({
    history: [{ validFrom: "2020-01-01", regime }],
    date: "2026-06-01",
    domesticWithholdingAgent,
    instrumentType,
  });

  it("refuses gain tax in managed, on a sale or as an adjustment", () => {
    assert.throws(() => checkTradeRegime(sellWithGainTax, context("managed", true, "fund")), regimeError("gainTaxCents"));
    assert.throws(() => checkTradeRegime(refund, context("managed", true, "fund")), regimeError("taxKind"));
  });

  it("allows gain tax in administered", () => {
    checkTradeRegime(sellWithGainTax, context("administered", true, "stock"));
    checkTradeRegime(refund, context("administered", true, null));
  });

  it("allows gain tax in self_declared only on a fund at a domestic withholding agent", () => {
    checkTradeRegime(sellWithGainTax, context("self_declared", true, "fund"));
    assert.throws(() => checkTradeRegime(sellWithGainTax, context("self_declared", true, "stock")), regimeError("gainTaxCents"));
    assert.throws(() => checkTradeRegime(sellWithGainTax, context("self_declared", false, "fund")), regimeError("gainTaxCents"));
    // An adjustment in self_declared names the fund it adjusts.
    checkTradeRegime(refund, context("self_declared", true, "fund"));
    assert.throws(() => checkTradeRegime(refund, context("self_declared", true, null)), regimeError("taxKind"));
  });

  it("allows an adjustment when any regime in force on or before its date allowed gain tax", () => {
    // An administered sale in December, self-declared from 1 January, a refund in February.
    const history = [
      { validFrom: "2025-03-10", regime: "administered" as const },
      { validFrom: "2026-01-01", regime: "self_declared" as const },
    ];
    checkTradeRegime(refund, { history, date: "2026-02-10", domesticWithholdingAgent: true, instrumentType: null });
    // A sale with gain tax on the same date is judged by the regime in force then.
    assert.throws(
      () => checkTradeRegime(sellWithGainTax, { history, date: "2026-02-10", domesticWithholdingAgent: true, instrumentType: "stock" }),
      regimeError("gainTaxCents"),
    );
    // Before the administered period started (the first period covers earlier dates): only it counts.
    const managedThenAdministered = [
      { validFrom: "2024-05-01", regime: "managed" as const },
      { validFrom: "2026-01-01", regime: "administered" as const },
    ];
    assert.throws(
      () => checkTradeRegime(refund, { history: managedThenAdministered, date: "2025-06-01", domesticWithholdingAgent: true, instrumentType: null }),
      regimeError("taxKind"),
    );
    checkTradeRegime(refund, { history: managedThenAdministered, date: "2026-06-01", domesticWithholdingAgent: true, instrumentType: null });
  });

  it("allows managed_result_tax in managed only", () => {
    const tax = amounts({ type: "tax", taxKind: "managed_result_tax", grossCents: 500 });
    checkTradeRegime(tax, context("managed", true, null));
    for (const regime of ["administered", "self_declared"] as const) {
      assert.throws(() => checkTradeRegime(tax, context(regime, true, null)), regimeError("taxKind"));
    }
  });

  it("refuses a domestic withholding on a bond trade's accrued interest unless the broker is a domestic withholding agent", () => {
    const bondSale = amounts({ type: "sell", grossCents: 100_000, accruedInterestCents: 1_000, withholdingDomesticCents: 125 });
    checkTradeRegime(bondSale, context("self_declared", true, "bond"));
    assert.throws(
      () => checkTradeRegime(bondSale, context("self_declared", false, "bond")),
      (error) => isValidationError(error, "domestic_withholding_requires_agent") && error.details.field === "withholdingDomesticCents",
    );
  });

  it("accepts a dividend's domestic withholding at any broker: it may have been taken upstream", () => {
    const dividend = amounts({ type: "dividend", grossCents: 10_000, withholdingDomesticCents: 2_600 });
    checkTradeRegime(dividend, context("self_declared", false, "stock"));
    assert.equal(tradeCashCents(dividend), 7_400);
  });

  it("refuses a trade on an account with no regime", () => {
    assert.throws(
      () => checkTradeRegime(amounts({ type: "buy", grossCents: 1 }), { history: [], date: "2026-01-01", domesticWithholdingAgent: null, instrumentType: "stock" }),
      (error) => isValidationError(error, "tax_regime_required"),
    );
  });

  it("accepts an ordinary buy in every regime", () => {
    for (const regime of ["administered", "self_declared", "managed"] as const) {
      checkTradeRegime(amounts({ type: "buy", grossCents: 1_000 }), context(regime, null, "stock"));
    }
  });
});

describe("checkTradeEntry and the cap on a single amount (#651, ADR 0002)", () => {
  const tooLarge = (label: string) => (error: unknown) =>
    isValidationError(error, "amount_too_large") && error.details.label === label && error.details.max === MAX_AMOUNT_CENTS;

  it("accepts a gross, fees and taxes at the cap", () => {
    checkTradeEntry(amounts({ type: "sell", grossCents: MAX_AMOUNT_CENTS }), "fund");
    checkTradeEntry(amounts({ type: "fee", feesCents: MAX_AMOUNT_CENTS }), null);
    checkTradeEntry(amounts({ type: "tax", grossCents: MAX_AMOUNT_CENTS }), null);
    checkTradeEntry(amounts({ type: "sell", grossCents: MAX_AMOUNT_CENTS, transactionTaxCents: MAX_AMOUNT_CENTS }), "fund");
  });

  it("refuses each amount one minor unit above the cap, naming the field", () => {
    for (const field of ["grossCents", "feesCents", "transactionTaxCents", "gainTaxCents"] as const) {
      assert.throws(
        () => checkTradeEntry(amounts({ type: "sell", grossCents: 1, [field]: MAX_AMOUNT_CENTS + 1 }), "fund"),
        tooLarge(field),
      );
    }
    assert.throws(
      () => checkTradeEntry(amounts({ type: "transfer", feesCents: 0, costBasisCents: MAX_AMOUNT_CENTS + 1 }), "fund"),
      tooLarge("costBasisCents"),
    );
  });

  it("refuses a trade whose cash leg would be above the cap", () => {
    assert.throws(
      () => checkTradeEntry(amounts({ type: "buy", grossCents: MAX_AMOUNT_CENTS, feesCents: 1 }), "fund"),
      tooLarge("cash"),
    );
  });
});

describe("checkRegimeChange (#653)", () => {
  type Regime = "self_declared" | "administered" | "managed";
  const since = (regime: Regime, validFrom = "2020-01-01") => [{ validFrom, regime }];
  const trade = (
    id: string,
    date: string,
    fields: Partial<Amounts> & Pick<Amounts, "type">,
    instrumentType: RegimeCheckedTrade["instrumentType"] = null,
  ): RegimeCheckedTrade => ({ ...amounts(fields), id, date, instrumentType });
  const conflict = (tradeId: string, tradeDate: string, code: string) => (error: unknown) =>
    isValidationError(error, "tax_regime_conflicts_with_trade") &&
    error.details.tradeId === tradeId &&
    error.details.tradeDate === tradeDate &&
    error.details.code === code;

  const managedTax = trade("t-managed", "2026-03-01", { type: "tax", taxKind: "managed_result_tax", grossCents: 500 });
  const stockSale = trade("t-stock", "2026-03-01", { type: "sell", grossCents: 10_000, gainTaxCents: 260 }, "stock");
  const fundSale = trade("t-fund", "2026-03-01", { type: "sell", grossCents: 10_000, gainTaxCents: 260 }, "fund");

  it("refuses a change that a managed result tax no longer fits", () => {
    assert.throws(
      () => checkRegimeChange([managedTax], { before: since("managed"), after: since("self_declared"), domesticWithholdingAgent: true }),
      conflict("t-managed", "2026-03-01", "tax_kind_not_allowed_in_regime"),
    );
  });

  it("refuses self_declared under an administered sale of a stock with gain tax, not of a fund at a withholding agent", () => {
    assert.throws(
      () => checkRegimeChange([stockSale], { before: since("administered"), after: since("self_declared"), domesticWithholdingAgent: true }),
      conflict("t-stock", "2026-03-01", "tax_kind_not_allowed_in_regime"),
    );
    checkRegimeChange([fundSale], { before: since("administered"), after: since("self_declared"), domesticWithholdingAgent: true });
  });

  it("judges only the trades in the periods the change covers", () => {
    // Self-declared from 2027: the 2026 sale stays under administered.
    checkRegimeChange([stockSale], {
      before: since("administered"),
      after: [...since("administered"), { validFrom: "2027-01-01", regime: "self_declared" }],
      domesticWithholdingAgent: true,
    });
    // A trade already at odds with a period the change leaves alone is not judged again.
    checkRegimeChange([stockSale], {
      before: since("self_declared"),
      after: [...since("self_declared"), { validFrom: "2027-01-01", regime: "administered" }],
      domesticWithholdingAgent: true,
    });
  });

  it("judges every trade when the account had no regime yet", () => {
    assert.throws(
      () => checkRegimeChange([stockSale], { before: [], after: since("self_declared"), domesticWithholdingAgent: false }),
      conflict("t-stock", "2026-03-01", "tax_kind_not_allowed_in_regime"),
    );
    checkRegimeChange([stockSale], { before: [], after: since("administered"), domesticWithholdingAgent: true });
  });

  it("names the earliest trade that breaks", () => {
    const later = trade("a-later", "2026-05-01", { type: "tax", taxKind: "managed_result_tax", grossCents: 1 });
    assert.throws(
      () => checkRegimeChange([later, managedTax], { before: since("managed"), after: since("administered"), domesticWithholdingAgent: true }),
      conflict("t-managed", "2026-03-01", "tax_kind_not_allowed_in_regime"),
    );
  });

  it("judges a gain tax adjustment when the regimes up to its date change", () => {
    const refund = trade("t-refund", "2026-02-10", { type: "tax", taxKind: "gain_tax_adjustment", grossCents: 100 });
    const administeredThenSelf = [...since("administered", "2025-01-01"), { validFrom: "2026-01-01", regime: "self_declared" as const }];
    // Its own period is still self_declared, but the administered one before it is gone.
    assert.throws(
      () =>
        checkRegimeChange([refund], {
          before: administeredThenSelf,
          after: [...since("managed", "2025-01-01"), { validFrom: "2026-01-01", regime: "self_declared" as const }],
          domesticWithholdingAgent: true,
        }),
      conflict("t-refund", "2026-02-10", "tax_kind_not_allowed_in_regime"),
    );
    checkRegimeChange([refund], { before: since("administered"), after: administeredThenSelf, domesticWithholdingAgent: true });
  });

  const bondBuy = trade(
    "t-bond",
    "2026-03-01",
    { type: "buy", grossCents: 10_000, accruedInterestCents: 100, withholdingDomesticCents: 12 },
    "bond",
  );

  it("checks the domestic-withholding rule on the first regime, not on a later change", () => {
    for (const domesticWithholdingAgent of [null, false]) {
      assert.throws(
        () => checkRegimeChange([bondBuy], { before: [], after: since("self_declared"), domesticWithholdingAgent }),
        conflict("t-bond", "2026-03-01", "domestic_withholding_requires_agent"),
      );
    }
    checkRegimeChange([bondBuy], { before: [], after: since("administered"), domesticWithholdingAgent: true });
    // A later change covers only the rules that depend on the regime: the broker did not change.
    checkRegimeChange([bondBuy], {
      before: since("self_declared"),
      after: [...since("self_declared"), { validFrom: "2027-01-01", regime: "self_declared" }],
      domesticWithholdingAgent: false,
    });
  });
});

describe("checkAccountTradesAgainstRegime (#653)", () => {
  const history = [{ validFrom: "2020-01-01", regime: "self_declared" as const }];
  const bondBuy: RegimeCheckedTrade = {
    ...amounts({ type: "buy", grossCents: 10_000, accruedInterestCents: 100, withholdingDomesticCents: 12 }),
    id: "t-bond",
    date: "2026-03-01",
    instrumentType: "bond",
  };

  it("refuses a broker that is not a withholding agent under a bond trade with domestic withholding", () => {
    assert.throws(
      () => checkAccountTradesAgainstRegime([bondBuy], { history, domesticWithholdingAgent: false }),
      (error: unknown) =>
        isValidationError(error, "tax_regime_conflicts_with_trade") &&
        error.details.tradeId === "t-bond" &&
        error.details.code === "domestic_withholding_requires_agent",
    );
    checkAccountTradesAgainstRegime([bondBuy], { history, domesticWithholdingAgent: true });
  });

  it("checks the rules that depend on the regime too", () => {
    const managedTax: RegimeCheckedTrade = {
      ...amounts({ type: "tax", taxKind: "managed_result_tax", grossCents: 500 }),
      id: "t-managed",
      date: "2026-03-01",
      instrumentType: null,
    };
    assert.throws(
      () => checkAccountTradesAgainstRegime([managedTax], { history, domesticWithholdingAgent: true }),
      (error: unknown) => isValidationError(error, "tax_regime_conflicts_with_trade") && error.details.code === "tax_kind_not_allowed_in_regime",
    );
  });
});
