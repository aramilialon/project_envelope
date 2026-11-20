import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { PositionTrade } from "./positions.ts";
import { checkTradeEntry, checkTradeRegime, tradeCashCents } from "./trades.ts";

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

describe("checkTradeEntry", () => {
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
  const regimeError = (field: string) => (error: unknown) =>
    isValidationError(error, "tax_kind_not_allowed_in_regime") && error.details.field === field;
  const sellWithGainTax = amounts({ type: "sell", grossCents: 10_000, gainTaxCents: 260 });
  const refund = amounts({ type: "tax", taxKind: "gain_tax_adjustment", grossCents: 100 });

  it("refuses gain tax in managed, on a sale or as an adjustment", () => {
    const context = { regime: "managed", domesticWithholdingAgent: true, instrumentType: "fund" } as const;
    assert.throws(() => checkTradeRegime(sellWithGainTax, context), regimeError("gainTaxCents"));
    assert.throws(() => checkTradeRegime(refund, context), regimeError("taxKind"));
  });

  it("allows gain tax in administered", () => {
    checkTradeRegime(sellWithGainTax, { regime: "administered", domesticWithholdingAgent: true, instrumentType: "stock" });
  });

  it("allows gain tax in self_declared only on a fund at a domestic withholding agent", () => {
    checkTradeRegime(sellWithGainTax, { regime: "self_declared", domesticWithholdingAgent: true, instrumentType: "fund" });
    assert.throws(
      () => checkTradeRegime(sellWithGainTax, { regime: "self_declared", domesticWithholdingAgent: true, instrumentType: "stock" }),
      regimeError("gainTaxCents"),
    );
    assert.throws(
      () => checkTradeRegime(sellWithGainTax, { regime: "self_declared", domesticWithholdingAgent: false, instrumentType: "fund" }),
      regimeError("gainTaxCents"),
    );
  });

  it("allows managed_result_tax in managed only", () => {
    const tax = amounts({ type: "tax", taxKind: "managed_result_tax", grossCents: 500 });
    checkTradeRegime(tax, { regime: "managed", domesticWithholdingAgent: true, instrumentType: null });
    for (const regime of ["administered", "self_declared"] as const) {
      assert.throws(() => checkTradeRegime(tax, { regime, domesticWithholdingAgent: true, instrumentType: null }), regimeError("taxKind"));
    }
  });

  it("refuses a domestic withholding unless the broker is a domestic withholding agent", () => {
    const dividend = amounts({ type: "dividend", grossCents: 1_000, withholdingDomesticCents: 260 });
    checkTradeRegime(dividend, { regime: "self_declared", domesticWithholdingAgent: true, instrumentType: "stock" });
    assert.throws(
      () => checkTradeRegime(dividend, { regime: "self_declared", domesticWithholdingAgent: false, instrumentType: "stock" }),
      (error) => isValidationError(error, "domestic_withholding_requires_agent"),
    );
  });

  it("accepts an ordinary buy in every regime", () => {
    for (const regime of ["administered", "self_declared", "managed"] as const) {
      checkTradeRegime(amounts({ type: "buy", grossCents: 1_000 }), { regime, domesticWithholdingAgent: null, instrumentType: "stock" });
    }
  });
});
