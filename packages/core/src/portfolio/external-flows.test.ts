import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { PriceLookup } from "./external-flows.ts";
import { externalFlows } from "./external-flows.ts";
import type { PositionTrade } from "./positions.ts";
import type { Price, Quantity } from "./quantity.ts";
import { ONE_UNIT, PRICE_FACTOR_HUNDREDTH, PRICE_FACTOR_ONE } from "./quantity.ts";
import { timeWeightedReturn } from "./returns.ts";

const ETF = "etf";
const BOND = "bond";

let sequence = 0;

function trade(fields: Partial<PositionTrade> & Pick<PositionTrade, "date" | "type">): PositionTrade {
  sequence += 1;
  const occurredAt = `${fields.date}T10:00:00Z`;
  return {
    id: `t-${sequence}`,
    accountId: "account",
    portfolioId: "portfolio",
    instrumentId: ETF,
    occurredAt,
    createdAt: occurredAt,
    currency: "EUR",
    quantity: 0 as Quantity,
    price: 0 as Price,
    priceFactor: PRICE_FACTOR_ONE,
    grossCents: 0,
    feesCents: 0,
    transactionTaxCents: 0,
    accruedInterestCents: 0,
    withholdingForeignCents: 0,
    withholdingDomesticCents: 0,
    gainTaxCents: 0,
    taxKind: null,
    costBasisCents: null,
    splitFrom: null,
    splitTo: null,
    transferTradeId: null,
    ...fields,
  };
}

function units(count: number): Quantity {
  return (count * ONE_UNIT) as Quantity;
}

const noPrice: PriceLookup = () => null;

describe("externalFlows", () => {
  it("a buy puts in everything it cost: gross, fees, transaction tax and accrued interest, less the withholding credited", () => {
    const buy = trade({
      date: "2025-09-10",
      type: "buy",
      instrumentId: BOND,
      grossCents: 987_654,
      feesCents: 500,
      transactionTaxCents: 100,
      accruedInterestCents: 2_000,
      withholdingDomesticCents: 250,
    });
    assert.deepEqual(externalFlows([buy], noPrice), [
      { tradeId: buy.id, date: "2025-09-10", amountCents: 987_654 + 500 + 100 + 2_000 - 250, kind: "contribution", currency: "EUR" },
    ]);
  });

  it("a sale takes out its net proceeds", () => {
    const sale = trade({ date: "2025-09-12", type: "sell", grossCents: 120_000, feesCents: 500, transactionTaxCents: 100, gainTaxCents: 2_600 });
    assert.deepEqual(externalFlows([sale], noPrice).map((flow) => flow.amountCents), [-(120_000 - 500 - 100 - 2_600)]);
  });

  it("a dividend or a coupon takes out its net cash as income", () => {
    const dividend = trade({ date: "2025-10-15", type: "dividend", grossCents: 6_000, withholdingForeignCents: 900, withholdingDomesticCents: 100 });
    assert.deepEqual(externalFlows([dividend], noPrice), [
      { tradeId: dividend.id, date: "2025-10-15", amountCents: -5_000, kind: "income", currency: "EUR" },
    ]);
  });

  it("a fee or a tax puts money in; a gain tax refund takes it out", () => {
    const fee = trade({ date: "2025-10-01", type: "fee", instrumentId: null, feesCents: 300 });
    const tax = trade({ date: "2025-10-02", type: "tax", instrumentId: null, taxKind: "stamp_duty", grossCents: 3_400 });
    const refund = trade({ date: "2025-10-03", type: "tax", instrumentId: null, taxKind: "gain_tax_adjustment", grossCents: 1_200 });
    const extra = trade({ date: "2025-10-04", type: "tax", instrumentId: null, taxKind: "gain_tax_adjustment", grossCents: -700 });
    assert.deepEqual(
      externalFlows([fee, tax, refund, extra], noPrice).map((flow) => [flow.amountCents, flow.kind]),
      [
        [300, "contribution"],
        [3_400, "contribution"],
        [-1_200, "contribution"],
        [700, "contribution"],
      ],
    );
  });

  it("a split is no flow", () => {
    assert.deepEqual(externalFlows([trade({ date: "2025-10-01", type: "split", splitFrom: 1, splitTo: 2 })], noPrice), []);
  });

  it("a transfer moves the market value of its units on its date, never their cost, plus its fees", () => {
    const prices: Record<string, number> = { "etf 2025-11-03": 87_123_456, "bond 2025-11-03": 98_765_432 };
    const priceOf: PriceLookup = (instrumentId, date) => (prices[`${instrumentId} ${date}`] ?? null) as Price | null;
    const incoming = trade({ date: "2025-11-03", type: "transfer", quantity: units(10), feesCents: 250, costBasisCents: 50_000 });
    const outgoing = trade({ date: "2025-11-03", type: "transfer", quantity: units(-10), feesCents: 250 });
    const bondIn = trade({ date: "2025-11-03", type: "transfer", instrumentId: BOND, quantity: units(10_000), priceFactor: PRICE_FACTOR_HUNDREDTH });
    assert.deepEqual(
      externalFlows([incoming, outgoing, bondIn], priceOf).map((flow) => flow.amountCents),
      [
        87_123 + 250, // 10 × €87.123456 = €871.23456, so €871.23, plus the fees
        -87_123 + 250, // out: minus the value, the fees still paid in
        987_654, // 10,000 nominal at 98.765432%
      ],
    );
  });

  it("a transfer with no price is an unknown flow, never 0", () => {
    const incoming = trade({ date: "2025-11-03", type: "transfer", quantity: units(10) });
    assert.deepEqual(externalFlows([incoming], noPrice).map((flow) => flow.amountCents), [null]);
  });

  it("keeps each flow in its account's currency", () => {
    const buy = trade({ date: "2025-09-10", type: "buy", currency: "USD", grossCents: 10_000 });
    assert.deepEqual(externalFlows([buy], noPrice).map((flow) => flow.currency), ["USD"]);
  });

  it("refuses a transfer with no instrument", () => {
    const transfer = trade({ date: "2025-11-03", type: "transfer", instrumentId: null, quantity: units(1) });
    assert.throws(
      () => externalFlows([transfer], noPrice),
      (error) => isValidationError(error) && error.code === "invalid_trade" && error.details["field"] === "instrumentId",
    );
  });

  it("feeds the time-weighted return: the September example from its trades", () => {
    const buy = trade({ date: "2025-09-10", type: "buy", grossCents: 199_000, feesCents: 1_000 });
    const flows = externalFlows([buy], noPrice);
    const outcome = timeWeightedReturn({
      start: { date: "2025-08-31", valueCents: 1_000_000 },
      valuations: [
        { date: "2025-09-10", valueCents: 1_210_000 },
        { date: "2025-09-30", valueCents: 1_230_000 },
      ],
      flows,
    });
    assert.deepEqual(outcome, { status: "known", returnE6: 26694, annualized: false });
  });
});
