import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import type { AccountPosition, PortfolioPosition, Positions, PositionTrade } from "./positions.ts";
import {
  applyTradeChanges,
  computePositions,
  summarizeByAccount,
  summarizeByPortfolio,
  validatePositionHistory,
  valuePosition,
} from "./positions.ts";
import type { Price, Quantity } from "./quantity.ts";
import { amountOf, PRICE_FACTOR_ONE } from "./quantity.ts";

/** Units as a Quantity: units(1.5) is 150000000. Only for readable test data. */
function units(value: number): Quantity {
  return Math.round(value * 1e8) as Quantity;
}

/** Euros as cents: eur(115.25) is 11525. Only for readable test data. */
function eur(value: number): Cents {
  return Math.round(value * 100);
}

/** A price in euros as a Price: price(28.8125) is 28812500. */
function price(value: number): Price {
  return Math.round(value * 1e6) as Price;
}

const ACCOUNT = "acc-1";
const OTHER_ACCOUNT = "acc-2";
const ETF = "etf";

let sequence = 0;

/** A trade with every field defaulted: a buy of nothing in portfolio A of acc-1. */
function trade(fields: Partial<PositionTrade> & { readonly date: string }): PositionTrade {
  sequence += 1;
  const id = fields.id ?? `t-${String(sequence).padStart(6, "0")}`;
  const occurredAt = fields.occurredAt ?? `${fields.date}T10:00:00Z`;
  return {
    id,
    accountId: ACCOUNT,
    portfolioId: "A",
    instrumentId: ETF,
    type: "buy",
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

function buy(date: string, portfolioId: string, quantity: number, unitPrice: number, fees: number, extra: Partial<PositionTrade> = {}) {
  return trade({
    date,
    portfolioId,
    type: "buy",
    quantity: units(quantity),
    price: price(unitPrice),
    grossCents: eur(quantity * unitPrice),
    feesCents: eur(fees),
    ...extra,
  });
}

function sell(date: string, portfolioId: string, quantity: number, unitPrice: number, fees: number, extra: Partial<PositionTrade> = {}) {
  return trade({
    date,
    portfolioId,
    type: "sell",
    quantity: units(quantity),
    price: price(unitPrice),
    grossCents: eur(quantity * unitPrice),
    feesCents: eur(fees),
    ...extra,
  });
}

function split(date: string, portfolioId: string, from: number, to: number, extra: Partial<PositionTrade> = {}) {
  return trade({ date, portfolioId, type: "split", splitFrom: from, splitTo: to, ...extra });
}

function account(positions: Positions, accountId = ACCOUNT, instrumentId = ETF): AccountPosition {
  const found = positions.accounts.find((p) => p.accountId === accountId && p.instrumentId === instrumentId);
  assert.ok(found, `no position for ${accountId}/${instrumentId}`);
  return found;
}

function portfolio(positions: Positions, portfolioId: string, accountId = ACCOUNT, instrumentId = ETF): PortfolioPosition {
  const found = positions.portfolios.find(
    (p) => p.portfolioId === portfolioId && p.accountId === accountId && p.instrumentId === instrumentId,
  );
  assert.ok(found, `no position for ${portfolioId} in ${accountId}/${instrumentId}`);
  return found;
}

/** The A/B table: two portfolios of one account share one average cost. */
function abHistory(): PositionTrade[] {
  return [
    buy("2026-01-10", "A", 10, 100, 5),
    buy("2026-01-20", "B", 30, 120, 5),
    sell("2026-02-10", "A", 5, 130, 5),
  ];
}

describe("computePositions: the A/B table", () => {
  it("shares one average cost between the portfolios of an account", () => {
    const positions = computePositions(abHistory().slice(0, 2));
    const position = account(positions);
    assert.equal(position.quantity, units(40));
    assert.equal(position.costBasisCents, eur(4610));
    assert.equal(position.averageCost, price(115.25));
    assert.equal(portfolio(positions, "A").averageCost, price(115.25));
    assert.equal(portfolio(positions, "B").averageCost, price(115.25));
  });

  it("realizes the gain of a sale at the account's average cost, in the selling portfolio", () => {
    const positions = computePositions(abHistory());
    const position = account(positions);
    assert.equal(position.quantity, units(35));
    assert.equal(position.costBasisCents, eur(4033.75));
    assert.equal(position.realizedCents, eur(68.75));
    assert.equal(position.costSoldCents, eur(576.25));
    assert.equal(position.tradeFeesCents, eur(15));

    const a = portfolio(positions, "A");
    const b = portfolio(positions, "B");
    assert.equal(a.quantity, units(5));
    assert.equal(a.costBasisCents, eur(576.25));
    assert.equal(a.realizedCents, eur(68.75));
    assert.equal(b.quantity, units(30));
    assert.equal(b.costBasisCents, eur(3457.5));
    assert.equal(b.realizedCents, 0);
  });

  it("splits 1:4: four times the units, the same cost, a quarter of the average", () => {
    const positions = computePositions([
      ...abHistory(),
      split("2026-03-01", "A", 1, 4),
      split("2026-03-01", "B", 1, 4),
    ]);
    const position = account(positions);
    assert.equal(position.quantity, units(140));
    assert.equal(position.costBasisCents, eur(4033.75));
    assert.equal(position.averageCost, price(28.8125));
    assert.equal(position.realizedCents, eur(68.75), "a split realizes nothing");
    assert.equal(portfolio(positions, "A").quantity, units(20));
    assert.equal(portfolio(positions, "B").quantity, units(120));
  });

  it("reverse splits 10:1 with a remainder of 0.5, then sells it for cash", () => {
    const history = [...abHistory(), split("2026-03-01", "A", 10, 1), split("2026-03-01", "B", 10, 1)];
    const afterSplit = computePositions(history);
    assert.equal(portfolio(afterSplit, "A").quantity, units(0.5));
    assert.equal(portfolio(afterSplit, "B").quantity, units(3));
    assert.equal(account(afterSplit).costBasisCents, eur(4033.75));

    const positions = computePositions([...history, sell("2026-03-05", "A", 0.5, 1300, 0)]);
    const a = portfolio(positions, "A");
    assert.equal(a.quantity, 0);
    assert.equal(a.realizedCents, eur(68.75) + eur(73.75));
    assert.equal(a.averageCost, null);
    assert.equal(account(positions).costSoldCents, eur(576.25) + eur(576.25));
    assert.equal(account(positions).costBasisCents, eur(3457.5));
  });

  it("rejects a sale of more than the portfolio holds, even if the account holds enough", () => {
    assert.throws(
      () => computePositions([...abHistory(), sell("2026-02-20", "A", 10, 130, 5, { id: "oversell" })]),
      (error) => {
        assert.ok(isValidationError(error, "insufficient_quantity"));
        assert.deepEqual(error.details, {
          tradeId: "oversell",
          accountId: ACCOUNT,
          portfolioId: "A",
          instrumentId: ETF,
          date: "2026-02-20",
          available: units(5),
          requested: units(10),
        });
        return true;
      },
    );
  });
});

describe("computePositions: selling out and transfers", () => {
  it("starts again from zero after selling everything", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 10, 100, 5),
      sell("2026-02-10", "A", 10, 110, 5),
      buy("2026-03-10", "A", 10, 90, 5),
    ]);
    const position = account(positions);
    assert.equal(position.quantity, units(10));
    assert.equal(position.costBasisCents, eur(905));
    assert.equal(position.averageCost, price(90.5));
    assert.equal(position.realizedCents, eur(1100 - 5 - 1005));
  });

  it("averages units transferred in from outside the app at the cost they carry", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 10, 120, 0),
      trade({ date: "2026-02-01", type: "transfer", quantity: units(10), costBasisCents: eur(1000) }),
    ]);
    const position = account(positions);
    assert.equal(position.quantity, units(20));
    assert.equal(position.costBasisCents, eur(2200));
    assert.equal(position.averageCost, price(110));
    assert.equal(position.realizedCents, 0);
    assert.equal(position.costInCents, eur(2200));
  });

  it("moves the proportional cost out with units transferred to another account, without a gain", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 3, 100, 0, { accountId: OTHER_ACCOUNT }),
      buy("2026-01-10", "A", 10, 120, 0),
      trade({
        id: "out",
        accountId: OTHER_ACCOUNT,
        date: "2026-02-01",
        type: "transfer",
        quantity: units(-1),
        transferTradeId: "in",
      }),
      trade({ id: "in", date: "2026-02-01", type: "transfer", quantity: units(1), transferTradeId: "out" }),
    ]);
    const source = account(positions, OTHER_ACCOUNT);
    assert.equal(source.quantity, units(2));
    assert.equal(source.costBasisCents, eur(200));
    assert.equal(source.costTransferredOutCents, eur(100));
    assert.equal(source.realizedCents, 0);
    const target = account(positions);
    assert.equal(target.quantity, units(11));
    assert.equal(target.costBasisCents, eur(1300));
  });

  it("moves only quantity between two portfolios of the same account", () => {
    const positions = computePositions([
      ...abHistory().slice(0, 2),
      trade({ id: "to-b", date: "2026-02-01", portfolioId: "B", type: "transfer", quantity: units(4), transferTradeId: "from-a" }),
      trade({ id: "from-a", date: "2026-02-01", portfolioId: "A", type: "transfer", quantity: units(-4), transferTradeId: "to-b" }),
    ]);
    const position = account(positions);
    assert.equal(position.quantity, units(40));
    assert.equal(position.costBasisCents, eur(4610));
    assert.equal(position.averageCost, price(115.25));
    assert.equal(position.costTransferredOutCents, 0);
    assert.equal(portfolio(positions, "A").quantity, units(6));
    assert.equal(portfolio(positions, "B").quantity, units(34));
    assert.equal(portfolio(positions, "A").costBasisCents + portfolio(positions, "B").costBasisCents, eur(4610));
  });

  it("rejects a transfer between portfolios of more than the source holds", () => {
    assert.throws(
      () =>
        computePositions([
          buy("2026-01-10", "A", 2, 100, 0),
          trade({ id: "in", date: "2026-02-01", portfolioId: "B", type: "transfer", quantity: units(3), transferTradeId: "out" }),
          trade({ id: "out", date: "2026-02-01", portfolioId: "A", type: "transfer", quantity: units(-3), transferTradeId: "in" }),
        ]),
      (error) => isValidationError(error, "insufficient_quantity") && error.details.portfolioId === "A",
    );
  });

  it("needs a cost on a transfer in from outside the app, and refuses one on a transfer with two legs", () => {
    assert.throws(
      () => computePositions([trade({ date: "2026-02-01", type: "transfer", quantity: units(1) })]),
      (error) => isValidationError(error, "invalid_trade") && error.details.field === "costBasisCents",
    );
    assert.throws(
      () =>
        computePositions([
          buy("2026-01-10", "A", 2, 100, 0, { accountId: OTHER_ACCOUNT }),
          trade({ id: "o", accountId: OTHER_ACCOUNT, date: "2026-02-01", type: "transfer", quantity: units(-1), transferTradeId: "i" }),
          trade({ id: "i", date: "2026-02-01", type: "transfer", quantity: units(1), transferTradeId: "o", costBasisCents: eur(100) }),
        ]),
      (error) => isValidationError(error, "invalid_trade") && error.details.field === "costBasisCents",
    );
  });

  it("refuses a transfer whose other leg is missing", () => {
    assert.throws(
      () => computePositions([trade({ date: "2026-02-01", type: "transfer", quantity: units(1), transferTradeId: "gone" })]),
      (error) => isValidationError(error, "invalid_trade") && error.details.field === "transferTradeId",
    );
  });

  it("refuses transfer legs with different quantities, dates or times", () => {
    const legs = (outFields: Partial<PositionTrade>) => [
      buy("2026-01-10", "A", 5, 100, 0, { accountId: OTHER_ACCOUNT }),
      trade({
        id: "o",
        accountId: OTHER_ACCOUNT,
        date: "2026-02-01",
        type: "transfer",
        quantity: units(-2),
        transferTradeId: "i",
        ...outFields,
      }),
      trade({ id: "i", date: "2026-02-01", type: "transfer", quantity: units(2), transferTradeId: "o" }),
    ];
    const cases: [Partial<PositionTrade>, string][] = [
      [{ quantity: units(-1) }, "quantity"],
      [{ quantity: units(2) }, "quantity"],
      [{ date: "2026-02-02", occurredAt: "2026-02-01T10:00:00Z" }, "date"],
      [{ occurredAt: "2026-02-01T11:00:00Z" }, "occurredAt"],
    ];
    for (const [fields, field] of cases) {
      assert.throws(
        () => computePositions(legs(fields)),
        (error) => isValidationError(error, "invalid_trade") && error.details.field === field,
        JSON.stringify(fields),
      );
    }
  });

  it("keeps a transfer's fees out of the cost, in their own total", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 10, 100, 0, { accountId: OTHER_ACCOUNT }),
      trade({
        id: "o",
        accountId: OTHER_ACCOUNT,
        date: "2026-02-01",
        type: "transfer",
        quantity: units(-10),
        transferTradeId: "i",
        feesCents: eur(25),
      }),
      trade({ id: "i", date: "2026-02-01", type: "transfer", quantity: units(10), transferTradeId: "o" }),
    ]);
    const source = account(positions, OTHER_ACCOUNT);
    assert.equal(source.transferFeesCents, eur(25));
    assert.equal(source.costBasisCents, 0);
    assert.equal(source.tradeFeesCents, 0);
    const target = account(positions);
    assert.equal(target.costBasisCents, eur(1000));
    assert.equal(target.averageCost, price(100));
  });

  it("carries a backdated buy in the source account through a transfer to the destination", () => {
    const history = [
      buy("2026-01-10", "A", 10, 100, 0, { accountId: OTHER_ACCOUNT }),
      trade({ id: "o", accountId: OTHER_ACCOUNT, date: "2026-03-01", type: "transfer", quantity: units(-5), transferTradeId: "i" }),
      trade({ id: "i", date: "2026-03-01", type: "transfer", quantity: units(5), transferTradeId: "o" }),
    ];
    assert.equal(account(computePositions(history)).costBasisCents, eur(500));
    const changed = applyTradeChanges(history, [
      { kind: "insert", trade: buy("2026-02-10", "A", 10, 130, 0, { accountId: OTHER_ACCOUNT }) },
    ]);
    const positions = computePositions(changed);
    // The source holds 20 for €2,300 when the 5 units leave: they carry €575.
    assert.equal(account(positions).costBasisCents, eur(575));
    assert.equal(account(positions, OTHER_ACCOUNT).costBasisCents, eur(1725));
    assert.equal(account(positions, OTHER_ACCOUNT).costTransferredOutCents, eur(575));
  });
});

describe("computePositions: the Italian examples", () => {
  it("keeps the transaction tax out of the cost, and the gain tax out of the gain", () => {
    const first = buy("2026-01-10", "A", 100, 50, 5, { transactionTaxCents: eur(5) });
    const afterFirst = account(computePositions([first]));
    assert.equal(afterFirst.costBasisCents, eur(5005));
    assert.equal(afterFirst.transactionTaxCents, eur(5));

    const second = buy("2026-02-10", "A", 50, 62, 5);
    assert.equal(account(computePositions([first, second])).costBasisCents, eur(8110));

    const sale = sell("2026-03-10", "A", 60, 70, 5, { gainTaxCents: eur(247.26) });
    const position = account(computePositions([first, second, sale]));
    assert.equal(position.costSoldCents, eur(3244));
    assert.equal(position.realizedCents, eur(951));
    assert.equal(position.gainTaxCents, eur(247.26));
    assert.equal(position.transactionTaxCents, eur(5));
    assert.equal(position.tradeFeesCents, eur(15));
    assert.equal(position.costBasisCents, eur(8110 - 3244));
    assert.equal(position.quantity, units(90));
  });

  it("keeps accrued interest out of the cost and the gain", () => {
    const position = account(
      computePositions([
        buy("2026-01-10", "A", 10, 100, 0, { accruedInterestCents: eur(12) }),
        sell("2026-02-10", "A", 10, 101, 0, { accruedInterestCents: eur(20) }),
      ]),
    );
    assert.equal(position.costInCents, eur(1000));
    assert.equal(position.realizedCents, eur(10));
    assert.equal(position.accruedInterestPaidCents, eur(12));
    assert.equal(position.accruedInterestReceivedCents, eur(20));
  });

  it("leaves the cost alone on dividends, fees and taxes, and keeps their totals", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 10, 100, 0),
      trade({
        date: "2026-02-10",
        type: "dividend",
        grossCents: eur(30),
        feesCents: eur(1),
        withholdingForeignCents: eur(4.5),
        withholdingDomesticCents: eur(6.63),
      }),
      trade({ date: "2026-02-11", type: "fee", feesCents: eur(2) }),
      trade({ date: "2026-02-12", type: "tax", taxKind: "stamp_duty", grossCents: eur(2) }),
      trade({ date: "2026-02-13", type: "tax", taxKind: "other", grossCents: eur(0.5) }),
      trade({ date: "2026-02-14", type: "fee", portfolioId: "B", instrumentId: null, feesCents: eur(3) }),
      trade({ date: "2026-02-15", type: "tax", portfolioId: "A", instrumentId: null, taxKind: "stamp_duty", grossCents: eur(34.2) }),
    ]);
    const position = account(positions);
    assert.equal(position.costBasisCents, eur(1000));
    assert.equal(position.dividendsCents, eur(30));
    assert.equal(position.incomeFeesCents, eur(1));
    assert.equal(position.tradeFeesCents, 0);
    assert.equal(position.withholdingForeignCents, eur(4.5));
    assert.equal(position.withholdingDomesticCents, eur(6.63));
    assert.equal(position.standaloneFeesCents, eur(2));
    assert.equal(position.standaloneTaxesCents, eur(2.5));
    assert.deepEqual(positions.charges, [
      { accountId: ACCOUNT, portfolioId: "A", currency: "EUR", standaloneFeesCents: 0, standaloneTaxesCents: eur(34.2), gainTaxCents: 0 },
      { accountId: ACCOUNT, portfolioId: "B", currency: "EUR", standaloneFeesCents: eur(3), standaloneTaxesCents: 0, gainTaxCents: 0 },
    ]);

    const [byAccount] = summarizeByAccount(positions);
    assert.equal(byAccount?.standaloneFeesCents, eur(5));
    assert.equal(byAccount?.standaloneTaxesCents, eur(36.7));
    assert.equal(byAccount?.costBasisCents, eur(1000));
    const byPortfolio = summarizeByPortfolio(positions);
    assert.deepEqual(
      byPortfolio.map((s) => [s.portfolioId, s.costBasisCents, s.standaloneFeesCents]),
      [
        ["A", eur(1000), eur(2)],
        ["B", 0, eur(3)],
      ],
    );
  });

  it("nets gain tax adjustments into the gain tax: a refund lowers it, extra tax raises it", () => {
    const history = [
      buy("2026-01-10", "A", 100, 50, 5, { transactionTaxCents: eur(5) }),
      buy("2026-02-10", "A", 50, 62, 5),
      sell("2026-03-10", "A", 60, 70, 5, { gainTaxCents: eur(247.26) }),
      trade({ date: "2026-04-10", type: "tax", taxKind: "gain_tax_adjustment", grossCents: eur(100) }),
    ];
    const position = account(computePositions(history));
    assert.equal(position.gainTaxCents, eur(147.26));
    assert.equal(position.standaloneTaxesCents, 0);
    assert.equal(position.realizedCents, eur(951), "taxes never change the gain");

    const extra = trade({ date: "2026-05-10", type: "tax", taxKind: "gain_tax_adjustment", grossCents: eur(-10) });
    assert.equal(account(computePositions([...history, extra])).gainTaxCents, eur(157.26));

    const withoutInstrument = trade({
      date: "2026-05-10",
      type: "tax",
      instrumentId: null,
      taxKind: "gain_tax_adjustment",
      grossCents: eur(20),
    });
    const positions = computePositions([...history, withoutInstrument]);
    assert.equal(positions.charges[0]?.gainTaxCents, eur(-20));
    assert.equal(summarizeByAccount(positions)[0]?.gainTaxCents, eur(127.26));
  });

  it("keeps a dividend's fee in income fees, apart from trade fees", () => {
    const position = account(
      computePositions([
        buy("2026-01-10", "A", 10, 100, 5),
        trade({
          date: "2026-02-10",
          type: "dividend",
          grossCents: eur(20),
          withholdingForeignCents: eur(3),
          withholdingDomesticCents: eur(4.42),
          feesCents: eur(2),
        }),
      ]),
    );
    const income =
      position.dividendsCents -
      position.withholdingForeignCents -
      position.withholdingDomesticCents -
      position.incomeFeesCents +
      position.accruedInterestReceivedCents -
      position.accruedInterestPaidCents;
    assert.equal(income, eur(10.58));
    assert.equal(position.tradeFeesCents, eur(5));
    assert.equal(position.costBasisCents, eur(1005));
  });

  it("counts a bond buy's domestic withholding as credited back", () => {
    const position = account(
      computePositions([
        buy("2026-01-10", "A", 10, 100, 0, { accruedInterestCents: eur(10), withholdingDomesticCents: eur(1.25) }),
        sell("2026-02-10", "A", 10, 100, 0, { accruedInterestCents: eur(30), withholdingDomesticCents: eur(3.75) }),
      ]),
    );
    assert.equal(position.withholdingDomesticCents, eur(2.5));
  });
});

describe("computePositions: replay order", () => {
  it("applies a split at the start of its date, before the date's other trades", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 5, 100, 0),
      buy("2026-03-01", "A", 10, 30, 0, { occurredAt: "2026-03-01T09:00:00Z" }),
      split("2026-03-01", "A", 1, 4, { occurredAt: "2026-03-01T18:00:00Z" }),
    ]);
    // 5 × 4 + 10, not (5 + 10) × 4.
    assert.equal(account(positions).quantity, units(30));
    assert.equal(account(positions).costBasisCents, eur(800));
  });

  it("orders trades of the same time by when they were recorded, then by id", () => {
    // A cost of €1.00 on 3 units: the first sale of 1 unit removes 33 cents, the second 34.
    const history = (createdAtOfA: string, idOfA: string) => [
      buy("2026-01-10", "A", 2, 0.5, 0),
      buy("2026-01-10", "B", 1, 0, 0),
      sell("2026-02-10", "A", 1, 0, 0, { id: idOfA, createdAt: createdAtOfA }),
      sell("2026-02-10", "B", 1, 0, 0, { id: "m", createdAt: "2026-02-10T10:00:00Z" }),
    ];
    const realized = (trades: PositionTrade[]) => {
      const positions = computePositions(trades);
      return [portfolio(positions, "A").realizedCents, portfolio(positions, "B").realizedCents];
    };
    // Recorded earlier: A's sale goes first.
    assert.deepEqual(realized(history("2026-02-10T09:00:00Z", "z")), [-33, -34]);
    // Recorded at the same time, smaller id: still first.
    assert.deepEqual(realized(history("2026-02-10T10:00:00Z", "a")), [-33, -34]);
    // Recorded at the same time, larger id: B's sale goes first.
    assert.deepEqual(realized(history("2026-02-10T10:00:00Z", "z")), [-34, -33]);
  });

  it("orders trades of one date by when they occurred before when they were recorded", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 2, 0.5, 0),
      buy("2026-01-10", "B", 1, 0, 0),
      sell("2026-02-10", "A", 1, 0, 0, { id: "x", occurredAt: "2026-02-10T09:00:00Z", createdAt: "2026-02-10T11:00:00Z" }),
      sell("2026-02-10", "B", 1, 0, 0, { id: "y", occurredAt: "2026-02-10T10:00:00Z", createdAt: "2026-02-10T10:00:00Z" }),
    ]);
    // X occurred first, so it removes 33 cents of €1.00 on 3 units, and Y 34.
    assert.equal(portfolio(positions, "A").realizedCents, -33);
    assert.equal(portfolio(positions, "B").realizedCents, -34);
  });

  it("orders timestamps with offsets by the instant they name", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 2, 0.5, 0),
      buy("2026-01-10", "B", 1, 0, 0),
      sell("2026-02-10", "A", 1, 0, 0, { id: "y", occurredAt: "2026-02-10T10:30:00+02:00" }),
      sell("2026-02-10", "B", 1, 0, 0, { id: "x", occurredAt: "2026-02-10T09:00:00.000001Z" }),
    ]);
    // 10:30+02:00 is 08:30Z: A's sale goes first although its id is larger.
    assert.equal(portfolio(positions, "A").realizedCents, -33);
  });

  it("accepts a sale of post-split units on the split's ex-date", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 10, 100, 0),
      split("2026-03-02", "A", 1, 2, { occurredAt: "2026-03-02T23:00:00Z" }),
      sell("2026-03-02", "A", 20, 55, 0, { occurredAt: "2026-03-02T08:00:00Z" }),
    ]);
    assert.equal(account(positions).quantity, 0);
    assert.equal(account(positions).realizedCents, eur(100));
  });

  it("gives the same result whatever the order of the input", () => {
    const history = [...abHistory(), split("2026-03-01", "A", 1, 4), split("2026-03-01", "B", 1, 4)];
    assert.deepEqual(computePositions([...history].reverse()), computePositions(history));
  });
});

describe("validatePositionHistory and applyTradeChanges", () => {
  const history = [
    buy("2026-01-10", "A", 10, 100, 0, { id: "buy" }),
    sell("2026-03-10", "A", 10, 110, 0, { id: "march-sale" }),
  ];

  it("accepts a valid history", () => {
    validatePositionHistory(history);
  });

  it("rejects a backdated sale that breaks a later one, at the later one's date", () => {
    const changed = applyTradeChanges(history, [{ kind: "insert", trade: sell("2026-02-10", "A", 5, 105, 0) }]);
    assert.throws(
      () => validatePositionHistory(changed),
      (error) => {
        assert.ok(isValidationError(error, "insufficient_quantity"));
        assert.equal(error.details.tradeId, "march-sale");
        assert.equal(error.details.date, "2026-03-10");
        assert.equal(error.details.available, units(5));
        assert.equal(error.details.requested, units(10));
        return true;
      },
    );
  });

  it("rejects moving a buy after the sale that needed it, and deleting it", () => {
    const moved = applyTradeChanges(history, [
      { kind: "update", trade: buy("2026-04-10", "A", 10, 100, 0, { id: "buy" }) },
    ]);
    assert.throws(() => validatePositionHistory(moved), (error) => isValidationError(error, "insufficient_quantity"));
    const deleted = applyTradeChanges(history, [{ kind: "delete", tradeId: "buy" }]);
    assert.equal(deleted.length, 1);
    assert.throws(() => validatePositionHistory(deleted), (error) => isValidationError(error, "insufficient_quantity"));
  });

  it("rejects a change to a trade that is not in the history", () => {
    assert.throws(
      () => applyTradeChanges(history, [{ kind: "delete", tradeId: "nope" }]),
      (error) => isValidationError(error, "unknown_trade") && error.details.tradeId === "nope",
    );
    assert.throws(
      () => applyTradeChanges(history, [{ kind: "insert", trade: history[0] as PositionTrade }]),
      (error) => isValidationError(error, "invalid_trade"),
    );
  });

  it("rejects a split that leaves out a portfolio holding the instrument", () => {
    assert.throws(
      () => validatePositionHistory([...abHistory(), split("2026-03-01", "A", 1, 4)]),
      (error) => {
        assert.ok(isValidationError(error, "split_missing_for_portfolio"));
        assert.deepEqual(error.details, { accountId: ACCOUNT, portfolioId: "B", instrumentId: ETF, date: "2026-03-01" });
        return true;
      },
    );
  });

  it("rejects a buy backdated before a split in a portfolio without a split row", () => {
    const withSplit = [buy("2026-01-10", "A", 10, 100, 0), split("2026-03-01", "A", 1, 2)];
    validatePositionHistory([...withSplit, buy("2026-03-01", "B", 1, 50, 0)]);
    assert.throws(
      () => validatePositionHistory([...withSplit, buy("2026-02-01", "B", 1, 100, 0)]),
      (error) => isValidationError(error, "split_missing_for_portfolio") && error.details.portfolioId === "B",
    );
  });

  it("rejects split rows of one date with different ratios", () => {
    assert.throws(
      () => validatePositionHistory([...abHistory(), split("2026-03-01", "A", 1, 4), split("2026-03-01", "B", 1, 2)]),
      (error) => {
        assert.ok(isValidationError(error, "split_ratio_mismatch"));
        assert.deepEqual(error.details, { accountId: ACCOUNT, instrumentId: ETF, date: "2026-03-01" });
        return true;
      },
    );
    // The same ratio written differently is the same ratio.
    validatePositionHistory([...abHistory(), split("2026-03-01", "A", 1, 2), split("2026-03-01", "B", 2, 4)]);
  });

  it("rejects two split rows of one portfolio on one date", () => {
    assert.throws(
      () =>
        validatePositionHistory([
          ...abHistory(),
          split("2026-03-01", "A", 1, 2),
          split("2026-03-01", "B", 1, 2),
          split("2026-03-01", "B", 1, 2),
        ]),
      (error) => {
        assert.ok(isValidationError(error, "split_duplicate"));
        assert.deepEqual(error.details, { accountId: ACCOUNT, instrumentId: ETF, date: "2026-03-01", portfolioId: "B" });
        return true;
      },
    );
  });

  it("rejects a split that rounds a position with a cost down to nothing", () => {
    assert.throws(
      () => validatePositionHistory([buy("2026-01-10", "A", 0.00000005, 100, 1), split("2026-03-01", "A", 10, 1)]),
      (error) => isValidationError(error, "split_leaves_no_quantity"),
    );
  });

  it("rejects malformed trades", () => {
    const cases: [Partial<PositionTrade>, string][] = [
      [{ type: "buy", instrumentId: null }, "instrumentId"],
      [{ type: "sell", quantity: units(-1) }, "quantity"],
      [{ type: "split", splitFrom: 0, splitTo: 1 }, "splitFrom"],
      [{ type: "buy", quantity: units(1), grossCents: -1 }, "grossCents"],
      [{ type: "buy", quantity: units(1), gainTaxCents: 1 }, "gainTaxCents"],
      [{ type: "buy", quantity: units(1), withholdingDomesticCents: 1 }, "withholdingDomesticCents"],
      [{ type: "sell", quantity: units(1), feesCents: -1 }, "feesCents"],
      [{ type: "dividend", withholdingDomesticCents: -1 }, "withholdingDomesticCents"],
      [{ type: "dividend", transactionTaxCents: 1 }, "transactionTaxCents"],
      [{ type: "dividend", quantity: units(1) }, "quantity"],
      [{ type: "fee", grossCents: 1 }, "grossCents"],
      [{ type: "fee", price: price(1) }, "price"],
      [{ type: "tax", taxKind: "stamp_duty", grossCents: -1 }, "grossCents"],
      [{ type: "tax" }, "taxKind"],
      [{ type: "dividend", taxKind: "other" }, "taxKind"],
      [{ type: "split", splitFrom: 1, splitTo: 2, grossCents: 1 }, "grossCents"],
      [{ type: "dividend", splitFrom: 1, splitTo: 2 }, "splitFrom"],
      [{ type: "transfer", quantity: units(1), transferTradeId: "x", grossCents: 1 }, "grossCents"],
      [{ type: "transfer", quantity: units(-1), costBasisCents: 1 }, "costBasisCents"],
      [{ type: "transfer", quantity: units(1), costBasisCents: -1 }, "costBasisCents"],
      [{ type: "dividend", transferTradeId: "x" }, "transferTradeId"],
      [{ type: "dividend", costBasisCents: 0 }, "costBasisCents"],
      [{ type: "dividend", occurredAt: "yesterday" }, "occurredAt"],
      [{ type: "dividend", occurredAt: "2026-01-01T10:00:00" }, "occurredAt"],
      [{ type: "dividend", occurredAt: "2026-01-01 10:00:00Z" }, "occurredAt"],
      [{ type: "dividend", occurredAt: "2026-02-30T10:00:00Z" }, "occurredAt"],
      [{ type: "dividend", occurredAt: "2026-01-01T24:00:00Z" }, "occurredAt"],
      [{ type: "dividend", createdAt: "1 January 2026" }, "createdAt"],
    ];
    for (const [fields, field] of cases) {
      assert.throws(
        () => computePositions([trade({ date: "2026-01-01", ...fields })]),
        (error) => isValidationError(error, "invalid_trade") && error.details.field === field,
        field,
      );
    }
  });
});

describe("portfolio cost and value", () => {
  it("splits the cost by quantity with the largest remainder, adding up exactly", () => {
    const positions = computePositions([
      buy("2026-01-10", "A", 1, 0.5, 0),
      buy("2026-01-10", "B", 1, 0.25, 0),
      buy("2026-01-10", "C", 1, 0.25, 0),
    ]);
    // €1.00 over three equal quantities: 33.33… each, the leftover cent to the smallest id.
    assert.deepEqual(
      positions.portfolios.map((p) => [p.portfolioId, p.costBasisCents]),
      [
        ["A", 34],
        ["B", 33],
        ["C", 33],
      ],
    );
  });

  it("hands the leftover cent to the largest remainder", () => {
    const positions = computePositions([buy("2026-01-10", "A", 1, 0.01, 0), buy("2026-01-10", "B", 2, 0, 0)]);
    // 1 cent over 1 and 2 units: remainders of a third and two thirds, so B gets it.
    assert.deepEqual(
      positions.portfolios.map((p) => [p.portfolioId, p.costBasisCents]),
      [
        ["A", 0],
        ["B", 1],
      ],
    );
  });

  it("removes the cost of a sale exactly, without a rounded average", () => {
    const positions = computePositions([
      trade({ date: "2026-01-10", type: "buy", quantity: units(300_000), price: price(0.333333), grossCents: eur(100_000) }),
      sell("2026-02-10", "A", 100_000, 0.5, 0),
    ]);
    const position = account(positions);
    assert.equal(position.costSoldCents, eur(33_333.33));
    assert.equal(position.costBasisCents, eur(66_666.67));
    assert.equal(position.averageCost, price(0.333333));
  });

  it("values a position at a price, rounded once", () => {
    const position = account(computePositions(abHistory()));
    assert.deepEqual(valuePosition(position, price(120)), { valueCents: eur(4200), unrealizedCents: eur(166.25) });
  });
});

// --- Property test ------------------------------------------------------------

/** Pseudo-random numbers with a fixed seed (mulberry32), so failures are reproducible. */
function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  readonly trades: PositionTrade[];
  /** The quantity each (account, instrument, portfolio) should end with. */
  readonly expected: Map<string, number>;
  readonly hasSplit: boolean;
}

const ACCOUNTS = ["acc-1", "acc-2"];
const INSTRUMENTS = ["etf", "bond"];
const PORTFOLIOS = ["P1", "P2", "P3"];

/**
 * A random valid history: buys, sells, dividends, fees, taxes, splits and
 * transfers (between portfolios, between accounts, from and to outside the
 * app), never selling more than a portfolio holds, with a split row for every
 * portfolio holding the instrument. Quantities run from 10^-8 to about 10^6
 * units, log-uniformly.
 */
function generateHistory(random: () => number): Generated {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const held = new Map<string, number>();
  const key = (a: string, i: string, p: string) => `${a}|${i}|${p}`;
  const trades: PositionTrade[] = [];
  let day = 1;
  let created = 0;
  let id = 0;
  let hasSplit = false;
  const nextId = () => `g-${String(++id).padStart(5, "0")}`;
  const stamp = () => {
    const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    // Several trades share a time; some share a creation time too, and are then ordered by id.
    if (random() < 0.7) created += 1;
    return { date, occurredAt: `${date}T12:00:00Z`, createdAt: new Date(Date.UTC(2026, 0, 1) + created * 1000).toISOString() };
  };
  const anyQuantity = () => Math.max(1, Math.floor(10 ** (random() * 14)));
  // Amounts follow quantity × a price between €0.01 and €10,000, as a broker's would.
  const amountFor = (quantity: number) =>
    amountOf(quantity as Quantity, Math.floor(10 ** (4 + random() * 6)) as Price, PRICE_FACTOR_ONE, "EUR");
  // Keeps every account's quantity well inside the safe range, splits included.
  const LIMIT = 1e15;
  const accountTotal = (a: string, i: string) => PORTFOLIOS.reduce((sum, p) => sum + (held.get(key(a, i, p)) ?? 0), 0);

  const count = 10 + Math.floor(random() * 50);
  for (let n = 0; n < count; n++) {
    if (random() < 0.4 && day < 300) day += 1;
    const accountId = pick(ACCOUNTS);
    const instrumentId = pick(INSTRUMENTS);
    const portfolioId = pick(PORTFOLIOS);
    const k = key(accountId, instrumentId, portfolioId);
    const have = held.get(k) ?? 0;
    const roll = random();
    const base = { accountId, instrumentId, portfolioId };

    if (roll < 0.35) {
      const quantity = anyQuantity();
      if (accountTotal(accountId, instrumentId) + quantity > LIMIT) continue;
      trades.push(
        trade({
          id: nextId(),
          ...stamp(),
          ...base,
          type: "buy",
          quantity: quantity as Quantity,
          grossCents: amountFor(quantity),
          feesCents: Math.floor(random() * 500),
          transactionTaxCents: Math.floor(random() * 50),
        }),
      );
      held.set(k, have + quantity);
    } else if (roll < 0.6 && have > 0) {
      const quantity = random() < 0.25 ? have : 1 + Math.floor(random() * have);
      trades.push(
        trade({
          id: nextId(),
          ...stamp(),
          ...base,
          type: "sell",
          quantity: quantity as Quantity,
          grossCents: amountFor(quantity),
          feesCents: Math.floor(random() * 500),
          gainTaxCents: Math.floor(random() * 100),
        }),
      );
      held.set(k, have - quantity);
    } else if (roll < 0.66 && have > 0) {
      // Between two portfolios of the same account, or to another account.
      const quantity = 1 + Math.floor(random() * have);
      const sameAccount = random() < 0.5;
      const toAccount = sameAccount ? accountId : pick(ACCOUNTS.filter((a) => a !== accountId));
      const toPortfolio = pick(PORTFOLIOS);
      if (!sameAccount && accountTotal(toAccount, instrumentId) + quantity > LIMIT) continue;
      const out = nextId();
      const into = nextId();
      const when = stamp();
      const fees = () => (random() < 0.3 ? Math.floor(random() * 3_000) : 0);
      trades.push(
        trade({ id: out, ...when, ...base, type: "transfer", quantity: -quantity as Quantity, transferTradeId: into, feesCents: fees() }),
        trade({
          id: into,
          ...when,
          accountId: toAccount,
          instrumentId,
          portfolioId: toPortfolio,
          type: "transfer",
          quantity: quantity as Quantity,
          transferTradeId: out,
          feesCents: fees(),
        }),
      );
      held.set(k, have - quantity);
      const target = key(toAccount, instrumentId, toPortfolio);
      held.set(target, (held.get(target) ?? 0) + quantity);
    } else if (roll < 0.7) {
      // From or to outside the app: a single leg.
      const outgoing = have > 0 && random() < 0.5;
      const quantity = outgoing ? 1 + Math.floor(random() * have) : anyQuantity();
      if (!outgoing && accountTotal(accountId, instrumentId) + quantity > LIMIT) continue;
      trades.push(
        trade({
          id: nextId(),
          ...stamp(),
          ...base,
          type: "transfer",
          quantity: (outgoing ? -quantity : quantity) as Quantity,
          costBasisCents: outgoing ? null : amountFor(quantity),
        }),
      );
      held.set(k, outgoing ? have - quantity : have + quantity);
    } else if (roll < 0.78) {
      // A split on a new date, one row per portfolio of the account holding the instrument.
      day += 1;
      const [from, to] = pick([[1, 2], [1, 3], [2, 1], [3, 2], [10, 1]] as const);
      const when = stamp();
      const holders = PORTFOLIOS.filter((p) => (held.get(key(accountId, instrumentId, p)) ?? 0) > 0);
      const after = (p: string) => Math.floor(((held.get(key(accountId, instrumentId, p)) ?? 0) * to) / from);
      const total = holders.reduce((sum, p) => sum + after(p), 0);
      if (holders.length === 0 || total === 0 || total > LIMIT) continue;
      for (const p of holders) {
        const quantity = after(p);
        trades.push(
          trade({ id: nextId(), ...when, accountId, instrumentId, portfolioId: p, type: "split", splitFrom: from, splitTo: to }),
        );
        held.set(key(accountId, instrumentId, p), quantity);
      }
      hasSplit = true;
      day += 1;
    } else if (roll < 0.88) {
      trades.push(
        trade({
          id: nextId(),
          ...stamp(),
          ...base,
          type: "dividend",
          grossCents: Math.floor(random() * 10_000),
          withholdingForeignCents: Math.floor(random() * 100),
        }),
      );
    } else if (roll < 0.94) {
      trades.push(trade({ id: nextId(), ...stamp(), ...base, type: "fee", feesCents: Math.floor(random() * 1_000) }));
    } else if (roll < 0.97) {
      const tax = { type: "tax", taxKind: "stamp_duty", grossCents: Math.floor(random() * 1_000) } as const;
      trades.push(trade({ id: nextId(), ...stamp(), ...base, instrumentId: random() < 0.5 ? null : instrumentId, ...tax }));
    } else {
      // A gain tax adjustment: positive is a refund, negative is extra tax.
      const tax = { type: "tax", taxKind: "gain_tax_adjustment", grossCents: Math.floor(random() * 2_000) - 1_000 } as const;
      trades.push(trade({ id: nextId(), ...stamp(), ...base, instrumentId: random() < 0.5 ? null : instrumentId, ...tax }));
    }
  }
  return { trades, expected: held, hasSplit };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

describe("computePositions: invariants on random histories", () => {
  it("keeps quantities and costs consistent on 500 seeded histories", () => {
    const random = randomGenerator(78);
    let splits = 0;
    let crossAccount = 0;
    let outside = 0;
    for (let run = 0; run < 500; run++) {
      const { trades, expected, hasSplit } = generateHistory(random);
      if (hasSplit) splits += 1;
      const positions = computePositions(trades);

      for (const position of positions.accounts) {
        const label = `run ${run}, ${position.accountId}/${position.instrumentId}`;
        const parts = positions.portfolios.filter(
          (p) => p.accountId === position.accountId && p.instrumentId === position.instrumentId,
        );
        // I1: the portfolios add up to the account, in quantity and cost, exactly.
        assert.equal(parts.reduce((sum, p) => sum + p.quantity, 0), position.quantity, `${label}: quantity`);
        assert.equal(parts.reduce((sum, p) => sum + p.costBasisCents, 0), position.costBasisCents, `${label}: cost`);
        // I2: no negative quantity.
        for (const part of parts) assert.ok(part.quantity >= 0, `${label}: ${part.portfolioId} negative`);
        // I3: every unit is accounted for (an independent count, splits included).
        for (const part of parts) {
          const count = expected.get(`${part.accountId}|${part.instrumentId}|${part.portfolioId}`) ?? 0;
          assert.equal(part.quantity, count, `${label}: ${part.portfolioId}`);
        }
        if (!hasSplit) {
          const own = trades.filter((t) => t.accountId === position.accountId && t.instrumentId === position.instrumentId);
          const delta = (t: PositionTrade) =>
            t.type === "buy" || t.type === "transfer" ? t.quantity : t.type === "sell" ? -t.quantity : 0;
          const signed = own.reduce((sum, t) => sum + delta(t), 0);
          assert.equal(position.quantity, signed, `${label}: signed sum of quantities`);
        }
        // I4: every cent of cost is accounted for, per account, and nothing is left without units.
        assert.equal(
          position.costInCents - position.costSoldCents - position.costTransferredOutCents,
          position.costBasisCents,
          `${label}: cost conservation`,
        );
        // No cost is ever left without units. The converse does not hold: units whose amount
        // rounds to €0.00, or that came free, are held at a cost of zero.
        if (position.quantity === 0) assert.equal(position.costBasisCents, 0, `${label}: cost without units`);
        assert.ok(position.costBasisCents >= 0, `${label}: negative cost`);
      }

      // Across accounts: a transfer between two accounts carries exactly the cost it removes, so,
      // per instrument and without transfers out of the app, the cost that entered the workspace
      // from outside is the cost that entered all accounts minus what moved between them.
      for (const instrumentId of INSTRUMENTS) {
        const own = trades.filter((t) => t.instrumentId === instrumentId);
        const linked = (t: PositionTrade) => t.type === "transfer" && t.transferTradeId !== null;
        const byId = new Map(own.map((t) => [t.id, t]));
        if (own.some((t) => linked(t) && byId.get(t.transferTradeId as string)?.accountId !== t.accountId)) crossAccount += 1;
        if (own.some((t) => t.type === "transfer" && !linked(t))) outside += 1;
        if (own.some((t) => t.type === "transfer" && !linked(t) && t.quantity < 0)) continue;
        const fromOutside = own.reduce(
          (sum, t) =>
            sum + (t.type === "buy" ? t.grossCents + t.feesCents : t.type === "transfer" && !linked(t) ? (t.costBasisCents ?? 0) : 0),
          0,
        );
        const rows = positions.accounts.filter((p) => p.instrumentId === instrumentId);
        const costIn = rows.reduce((sum, p) => sum + p.costInCents, 0);
        const movedOut = rows.reduce((sum, p) => sum + p.costTransferredOutCents, 0);
        assert.equal(costIn - movedOut, fromOutside, `run ${run}, ${instrumentId}: cost carried between accounts`);
      }

      // Rebuildability: the order of the input changes nothing.
      assert.deepEqual(computePositions(shuffle(trades, random)), positions, `run ${run}: shuffled`);
    }
    assert.ok(splits > 50, `only ${splits} runs had a split`);
    assert.ok(crossAccount > 100, `only ${crossAccount} instrument histories had a transfer between accounts`);
    assert.ok(outside > 100, `only ${outside} instrument histories had a transfer from or to outside the app`);
  });

  it("rejects any sale of one unit more than a portfolio holds", () => {
    const random = randomGenerator(7878);
    let checked = 0;
    for (let run = 0; run < 200; run++) {
      const { trades } = generateHistory(random);
      const positions = computePositions(trades);
      const holder = positions.portfolios.find((p) => p.quantity > 0);
      if (holder === undefined) continue;
      const oversell = trade({
        date: "2030-01-01",
        accountId: holder.accountId,
        instrumentId: holder.instrumentId,
        portfolioId: holder.portfolioId,
        type: "sell",
        quantity: (holder.quantity + 1) as Quantity,
      });
      assert.throws(
        () => validatePositionHistory([...trades, oversell]),
        (error) => isValidationError(error, "insufficient_quantity") && error.details.available === holder.quantity,
        `run ${run}`,
      );
      checked += 1;
    }
    assert.ok(checked > 100);
  });
});
