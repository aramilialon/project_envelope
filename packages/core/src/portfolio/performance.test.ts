import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { FxRate } from "../market-data/fx.ts";
import type { MonthlyPerformanceInput, PortfolioPerformance } from "./performance.ts";
import { assertPerformanceRange, lastDayOfMonth, MAX_PERFORMANCE_MONTHS, monthlyPerformance } from "./performance.ts";
import type { PositionTrade } from "./positions.ts";
import type { PriceCandidate, PriceOrigin } from "./prices.ts";
import type { Price, Quantity } from "./quantity.ts";
import { ONE_UNIT, PRICE_FACTOR_ONE } from "./quantity.ts";

const PORTFOLIO = "portfolio";
const ETF = "etf-eur";
const STOCK = "stock-usd";

let sequence = 0;

function trade(fields: Partial<PositionTrade> & Pick<PositionTrade, "date" | "type">): PositionTrade {
  sequence += 1;
  const occurredAt = `${fields.date}T10:00:00Z`;
  return {
    id: `t-${String(sequence).padStart(4, "0")}`,
    accountId: "account-eur",
    portfolioId: PORTFOLIO,
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

/** A price × 10^6. */
function e6(price: number): Price {
  return Math.round(price * 1_000_000) as Price;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function buy(date: string, instrumentId: string, count: number, price: number, extra: Partial<PositionTrade> = {}): PositionTrade {
  const usd = instrumentId === STOCK;
  return trade({
    date,
    type: "buy",
    instrumentId,
    accountId: usd ? "account-usd" : "account-eur",
    currency: usd ? "USD" : "EUR",
    quantity: units(count),
    price: e6(price),
    grossCents: cents(count * price),
    ...extra,
  });
}

function prices(entries: Record<string, number>, origin: PriceOrigin = "shared"): PriceCandidate[] {
  return Object.entries(entries).map(([priceDate, close]) => ({ priceDate, closeE6: e6(close), origin }));
}

function usd(date: string, rate: number): FxRate {
  return { base: "EUR", quote: "USD", date, rateE10: Math.round(rate * 1e10) };
}

function input(fields: Partial<MonthlyPerformanceInput> & Pick<MonthlyPerformanceInput, "trades">): MonthlyPerformanceInput {
  return {
    portfolioId: PORTFOLIO,
    priceCandidates: new Map(),
    fxRates: [],
    baseCurrency: "EUR",
    from: "2026-09",
    to: "2026-10",
    today: "2026-11-15",
    ...fields,
  };
}

function throwsCode(fn: () => unknown, code: string, details?: Record<string, unknown>): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(isValidationError(error), String(error));
    assert.equal(error.code, code);
    if (details) assert.deepEqual({ ...error.details }, details);
    return true;
  });
}

/**
 * The reference example, checked by hand (twice: with exact fractions, and
 * with a separate bisection for the MWR). Base currency EUR; a euro ETF in a
 * euro account and a dollar stock in a dollar account, one portfolio.
 *
 * | Date | Event | ETF | Stock | USD per € | Value (€) |
 * | --- | --- | --- | --- | --- | --- |
 * | 3 Aug | buy 100 ETF at €100 | 100 | | | 10,000.00 |
 * | 31 Aug | | 100 | | | 10,000.00 |
 * | 10 Sep | buy 10 stock at $200 + $5 fees: flow $2,005 = €1,604 | 105 | 200 | 1.25 | 10,500 + 1,600 = 12,100.00 |
 * | 30 Sep | | 106 | 210 | 1.20 | 10,600 + 1,750 = 12,350.00 |
 * | 15 Oct | dividend $25 − $5 withheld: flow −$20 = −€16 | (106) | (210) | 1.25 | 10,600 + 1,680 = 12,280.00 |
 * | 31 Oct (Sat) | | 104 | 220 (30 Oct) | 1.10 (30 Oct) | 10,400 + 2,000 = 12,400.00 |
 *
 * September: contributions 1,604, gain 12,350 − 10,000 − 1,604 = 746;
 * TWR (12,100 − 1,604) ÷ 10,000 × 12,350 ÷ 12,100 − 1 = 7.128595%;
 * MWR (−10,000 on 31 Aug, −1,604 on 10 Sep, +12,350 on 30 Sep) 6.746457%.
 * October: income 16, gain 12,400 − 12,350 + 16 = 66;
 * TWR 12,296 ÷ 12,350 × 12,400 ÷ 12,280 − 1 = 0.535679%;
 * MWR (−12,350 on 30 Sep, +16 on 15 Oct, +12,400 on 31 Oct) 0.534770%.
 * Both months: gain 812 (= 746 + 66); TWR 7.702460% (one call, not the
 * rounded months linked); MWR 7.167262%.
 */
function reference(): MonthlyPerformanceInput {
  return input({
    trades: [
      buy("2026-08-03", ETF, 100, 100),
      buy("2026-09-10", STOCK, 10, 200, { feesCents: 500 }),
      trade({
        date: "2026-10-15",
        type: "dividend",
        instrumentId: STOCK,
        accountId: "account-usd",
        currency: "USD",
        grossCents: 2500,
        withholdingForeignCents: 500,
      }),
    ],
    priceCandidates: new Map([
      [ETF, prices({ "2026-08-03": 100, "2026-09-10": 105, "2026-09-30": 106, "2026-10-31": 104 })],
      [STOCK, prices({ "2026-09-10": 200, "2026-09-30": 210, "2026-10-30": 220 })],
    ]),
    fxRates: [usd("2026-08-31", 1.1), usd("2026-09-10", 1.25), usd("2026-09-30", 1.2), usd("2026-10-15", 1.25), usd("2026-10-30", 1.1)],
  });
}

describe("monthlyPerformance: the reference example (two months, two currencies)", () => {
  const result: PortfolioPerformance = monthlyPerformance(reference());

  it("values each month at its last day, each currency at that date's rate", () => {
    assert.deepEqual(
      result.months.map((row) => [row.month, row.valuationDate, row.valueCents, row.oldestPriceDate, row.oldestRateDate]),
      [
        ["2026-09", "2026-09-30", cents(12_350), "2026-09-30", "2026-09-30"],
        ["2026-10", "2026-10-31", cents(12_400), "2026-10-30", "2026-10-30"],
      ],
    );
  });

  it("converts each flow at its own date's rate, fees included, and keeps income apart", () => {
    const [september, october] = result.months;
    assert.equal(september?.netContributionsCents, cents(1_604));
    assert.equal(september?.incomeCents, 0);
    assert.equal(october?.netContributionsCents, 0);
    assert.equal(october?.incomeCents, cents(16));
  });

  it("the gain is value − previous value − contributions + income, exact in cents", () => {
    assert.deepEqual(
      result.months.map((row) => row.gainCents),
      [cents(746), cents(66)],
    );
    assert.equal(result.totals.gainCents, cents(812));
  });

  it("returns match the hand-checked figures", () => {
    assert.deepEqual(
      result.months.map((row) => [row.twrE6, row.mwrE6]),
      [
        [71_286, 67_465],
        [5_357, 5_348],
      ],
    );
    assert.equal(result.totals.twrE6, 77_025);
    assert.equal(result.totals.twrAnnualized, false);
    assert.equal(result.totals.mwrE6, 71_673);
    assert.equal(result.totals.mwrAnnualized, false);
  });

  it("the totals run from the end of the month before the range", () => {
    assert.equal(result.totals.startDate, "2026-08-31");
    assert.equal(result.totals.endDate, "2026-10-31");
    assert.equal(result.totals.startValueCents, cents(10_000));
    assert.equal(result.totals.endValueCents, cents(12_400));
    assert.equal(result.totals.netContributionsCents, cents(1_604));
    assert.equal(result.totals.incomeCents, cents(16));
    assert.deepEqual(result.totals.missing, []);
    assert.equal(result.baseCurrency, "EUR");
  });
});

describe("monthlyPerformance: unknown values", () => {
  it("an instrument with no price makes the value null, never a partial sum, and is listed", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [buy("2026-08-03", ETF, 100, 100), buy("2026-09-10", "unpriced", 5, 50)],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    const [row] = result.months;
    assert.equal(row?.valueCents, null);
    assert.equal(row?.gainCents, null);
    assert.equal(row?.twrE6, null);
    assert.equal(row?.mwrE6, null);
    assert.equal(row?.oldestPriceDate, null);
    assert.equal(row?.netContributionsCents, cents(250), "the buy's own cash is known");
    assert.deepEqual(row?.missing, [{ instrumentId: "unpriced", reason: "no_price", date: "2026-09-10" }]);
    assert.equal(row?.twrUnknownReason, "missing_value");
    assert.equal(row?.mwrUnknownReason, "missing_value");
    assert.equal(result.totals.startValueCents, cents(10_000));
    assert.equal(result.totals.endValueCents, null);
    assert.equal(result.totals.twrUnknownReason, "missing_value");
    assert.equal(result.totals.mwrUnknownReason, "missing_value");
  });

  it("dates each missing entry at the earliest date, among those its figure needed, that lacks it", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-11",
        trades: [buy("2026-08-03", ETF, 100, 100), buy("2026-09-10", "unpriced", 5, 50)],
        priceCandidates: new Map([
          [ETF, prices({ "2026-08-03": 100 })],
          ["unpriced", prices({ "2026-11-02": 60 })],
        ]),
      }),
    );
    const dates = result.months.map((row) => row.missing.map((entry) => entry.date));
    // September from its buy; October from its start, the end of September; November is priced.
    assert.deepEqual(dates, [["2026-09-10"], ["2026-09-30"], ["2026-10-31"]]);
    assert.deepEqual(result.totals.missing, [{ instrumentId: "unpriced", reason: "no_price", date: "2026-09-10" }]);
  });

  it("a position sold out needs no price", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-10",
        to: "2026-10",
        trades: [
          buy("2026-08-03", "gone", 10, 10),
          trade({ date: "2026-09-01", type: "sell", instrumentId: "gone", quantity: units(10), price: e6(10), grossCents: cents(100) }),
          buy("2026-08-03", ETF, 1, 100),
        ],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    assert.equal(result.months[0]?.valueCents, cents(100));
    assert.deepEqual(result.months[0]?.missing, []);
  });

  it("a currency with no rate makes the value null and names the currency", () => {
    const base = reference();
    const result = monthlyPerformance({ ...base, fxRates: [] });
    const [september] = result.months;
    assert.equal(september?.valueCents, null);
    assert.equal(september?.netContributionsCents, null, "the dollar buy cannot be converted");
    assert.equal(september?.gainCents, null);
    assert.deepEqual(september?.missing, [{ instrumentId: STOCK, reason: "no_rate", currency: "USD", date: "2026-09-10" }]);
    assert.equal(result.totals.startValueCents, cents(10_000), "the euro holding needs no rate");
  });

  it("a base currency with no rate names the base currency", () => {
    const result = monthlyPerformance({ ...reference(), baseCurrency: "GBP" });
    assert.deepEqual(result.months[0]?.missing, [
      { instrumentId: ETF, reason: "no_rate", currency: "GBP", date: "2026-08-31" },
      { instrumentId: STOCK, reason: "no_rate", currency: "GBP", date: "2026-09-10" },
    ]);
  });

  it("an account-wide fee whose currency has no rate is listed without an instrument", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [
          buy("2026-08-03", ETF, 1, 100),
          trade({ date: "2026-09-05", type: "fee", instrumentId: null, accountId: "account-usd", currency: "USD", feesCents: 300 }),
        ],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    assert.equal(result.months[0]?.valueCents, cents(100));
    assert.equal(result.months[0]?.netContributionsCents, null);
    assert.deepEqual(result.months[0]?.missing, [{ instrumentId: null, reason: "no_rate", currency: "USD", date: "2026-09-05" }]);
  });

  it("an unknown flow makes the sum unknown whether it comes first or last", () => {
    // Two flows on different dates: the unconvertible one first, then last.
    for (const order of [
      ["2026-09-05", "2026-09-20"],
      ["2026-09-20", "2026-09-05"],
    ] as const) {
      const [usdDate, eurDate] = order;
      const result = monthlyPerformance(
        input({
          from: "2026-09",
          to: "2026-09",
          trades: [
            buy("2026-08-03", ETF, 1, 100),
            trade({ date: usdDate, type: "fee", instrumentId: null, accountId: "account-usd", currency: "USD", feesCents: 300 }),
            trade({ date: eurDate, type: "fee", instrumentId: null, feesCents: 200 }),
          ],
          priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
        }),
      );
      assert.equal(result.months[0]?.netContributionsCents, null, `USD fee on ${usdDate}`);
    }
  });
});

describe("monthlyPerformance: prices", () => {
  it("the workspace's own price overrides the shared one of the same date", () => {
    const candidates = [...prices({ "2026-09-30": 100 }, "shared"), ...prices({ "2026-09-30": 90 }, "own")];
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [buy("2026-08-03", ETF, 10, 100)],
        priceCandidates: new Map([[ETF, [...candidates, ...prices({ "2026-08-03": 100 })]]]),
      }),
    );
    assert.equal(result.months[0]?.valueCents, cents(900));
  });

  it("uses the latest price on or before the date however old, and reports its date", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-10",
        to: "2026-10",
        trades: [buy("2025-01-10", ETF, 10, 100)],
        priceCandidates: new Map([[ETF, prices({ "2025-01-10": 100, "2026-11-01": 999 })]]),
      }),
    );
    assert.equal(result.months[0]?.valueCents, cents(1_000));
    assert.equal(result.months[0]?.oldestPriceDate, "2025-01-10");
    assert.equal(result.months[0]?.oldestRateDate, null, "a euro holding uses no rate");
  });

  it("a transfer in is a flow at its market value; with no price on its date the flow is unknown", () => {
    const transferIn = (date: string) =>
      trade({ date, type: "transfer", instrumentId: ETF, quantity: units(10), costBasisCents: cents(500) });
    const priced = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [transferIn("2026-09-10")],
        priceCandidates: new Map([[ETF, prices({ "2026-09-10": 100, "2026-09-30": 101 })]]),
      }),
    );
    assert.equal(priced.months[0]?.netContributionsCents, cents(1_000), "market value, never its cost");
    assert.equal(priced.months[0]?.gainCents, cents(10));
    assert.equal(priced.months[0]?.twrE6, 10_000);

    const unpriced = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [transferIn("2026-09-10")],
        priceCandidates: new Map([[ETF, prices({ "2026-09-30": 101 })]]),
      }),
    );
    assert.equal(unpriced.months[0]?.valueCents, cents(1_010));
    assert.equal(unpriced.months[0]?.netContributionsCents, null);
    assert.equal(unpriced.months[0]?.gainCents, null);
    assert.deepEqual(unpriced.months[0]?.missing, [{ instrumentId: ETF, reason: "no_price", date: "2026-09-10" }]);
  });

  it("counts only the portfolio's own trades and positions", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [buy("2026-08-03", ETF, 10, 100), buy("2026-09-10", ETF, 5, 100, { portfolioId: "other" })],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    assert.equal(result.months[0]?.valueCents, cents(1_000));
    assert.equal(result.months[0]?.netContributionsCents, 0);
  });
});

describe("monthlyPerformance: flows of one date", () => {
  it("adds up the amounts of one date and one currency, then converts them once", () => {
    // $0.01 + $0.01 at 1.6 dollars per euro: $0.02 is €0.0125, so €0.01; each cent apart would give €0.02.
    const fee = () => trade({ date: "2026-09-05", type: "fee", instrumentId: null, accountId: "account-usd", currency: "USD", feesCents: 1 });
    const result = monthlyPerformance(
      input({ from: "2026-09", to: "2026-09", trades: [fee(), fee()], fxRates: [usd("2026-09-05", 1.6)] }),
    );
    assert.equal(result.months[0]?.netContributionsCents, 1);
  });

  it("keeps a buy and a dividend of the same currency and date apart", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [
          buy("2026-08-03", ETF, 10, 100),
          buy("2026-09-10", ETF, 10, 100),
          trade({ date: "2026-09-10", type: "dividend", instrumentId: ETF, grossCents: cents(50) }),
        ],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    assert.equal(result.months[0]?.netContributionsCents, cents(1_000), "not €950");
    assert.equal(result.months[0]?.incomeCents, cents(50));
    assert.equal(result.months[0]?.gainCents, cents(50));
  });

  it("a transfer between two accounts of the same portfolio nets to its fees", () => {
    const when = { date: "2026-09-10", type: "transfer", instrumentId: ETF } as const;
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [
          buy("2026-08-03", ETF, 10, 100),
          trade({ ...when, id: "out", quantity: -units(4) as Quantity, transferTradeId: "in", feesCents: 300 }),
          trade({ ...when, id: "in", accountId: "account-eur-2", quantity: units(4), transferTradeId: "out", feesCents: 200 }),
        ],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100, "2026-09-10": 110 })]]),
      }),
    );
    assert.equal(result.months[0]?.netContributionsCents, 500);
    assert.equal(result.months[0]?.valueCents, cents(1_100));
    assert.equal(result.months[0]?.gainCents, cents(100) - 500);
  });
});

describe("monthlyPerformance: why a return is unknown", () => {
  it("names no reason when both returns are known", () => {
    const result = monthlyPerformance(reference());
    for (const row of [...result.months, result.totals]) {
      assert.deepEqual([row.twrUnknownReason, row.mwrUnknownReason], [null, null]);
    }
  });

  it("a month after selling out, with only a fee and a dividend, has no capital for either return", () => {
    // Domain expert, 2026-11-22: 10 units worth €1,000 on 31 August, sold for €1,010 on 10 September,
    // a €2 fee on 5 October and a €50 dividend on 20 October.
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-10",
        trades: [
          buy("2026-08-03", ETF, 10, 100),
          trade({ date: "2026-09-10", type: "sell", instrumentId: ETF, quantity: units(10), price: e6(101), grossCents: cents(1_010) }),
          trade({ date: "2026-10-05", type: "fee", instrumentId: null, feesCents: cents(2) }),
          trade({ date: "2026-10-20", type: "dividend", instrumentId: ETF, grossCents: cents(50) }),
        ],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    const october = result.months[1];
    assert.deepEqual(
      [october?.valueCents, october?.netContributionsCents, october?.incomeCents, october?.gainCents],
      [0, cents(2), cents(50), cents(48)],
    );
    assert.deepEqual([october?.twrE6, october?.twrUnknownReason], [null, "no_capital"]);
    // Nothing held at the end of any day October is valued on (#89): no_capital, no longer no_solution.
    assert.deepEqual([october?.mwrE6, october?.mwrUnknownReason], [null, "no_capital"]);
    assert.equal(result.months[0]?.gainCents, cents(10));
    assert.equal(result.totals.twrE6, 10_000);
    assert.equal(result.totals.twrUnknownReason, null);
    assert.equal(result.totals.gainCents, cents(58));
  });
});

describe("monthlyPerformance: nothing held (domain expert, #89)", () => {
  const fee = (date: string, amount: number) => trade({ date, type: "fee", instrumentId: null, feesCents: cents(amount) });
  const sell = (date: string, count: number, price: number, extra: Partial<PositionTrade> = {}) =>
    trade({ date, type: "sell", instrumentId: ETF, quantity: units(count), price: e6(price), grossCents: cents(count * price), ...extra });
  const figures = (row: { gainCents: number | null; twrE6: number | null; mwrE6: number | null; twrUnknownReason: string | null; mwrUnknownReason: string | null } | undefined) => [
    row?.gainCents,
    row?.twrE6,
    row?.twrUnknownReason,
    row?.mwrE6,
    row?.mwrUnknownReason,
  ];

  it("a month with only a €5 fee shows a gain of −5.00 and no return, not −100%", () => {
    const result = monthlyPerformance(input({ from: "2026-10", to: "2026-10", trades: [fee("2026-10-03", 5)] }));
    assert.deepEqual(figures(result.months[0]), [cents(-5), null, "no_capital", null, "no_capital"]);
    assert.deepEqual(figures(result.totals), [cents(-5), null, "no_capital", null, "no_capital"]);
  });

  it("a €5 fee and a €50 dividend with nothing held: +45.00 and no return, not +900%", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-10",
        to: "2026-10",
        trades: [
          buy("2026-08-03", ETF, 10, 100),
          sell("2026-09-10", 10, 101),
          fee("2026-10-03", 5),
          trade({ date: "2026-10-20", type: "dividend", instrumentId: ETF, grossCents: cents(50) }),
        ],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100 })]]),
      }),
    );
    assert.deepEqual(figures(result.months[0]), [cents(45), null, "no_capital", null, "no_capital"]);
  });

  it("bought for €10,010 and sold for €9,980 on the same day: −30.00 and no return, not −100%", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-10",
        to: "2026-10",
        trades: [buy("2026-10-05", ETF, 100, 100, { feesCents: cents(10) }), sell("2026-10-05", 100, 99.9, { feesCents: cents(10) })],
        priceCandidates: new Map([[ETF, prices({ "2026-10-05": 100 })]]),
      }),
    );
    assert.deepEqual(figures(result.months[0]), [cents(-30), null, "no_capital", null, "no_capital"]);
  });

  it("bought for €10,000 on 5 October and sold for a net €10,100 on 20 October is held: 1.00% either way", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-10",
        to: "2026-10",
        trades: [buy("2026-10-05", ETF, 100, 100), sell("2026-10-20", 100, 101)],
        priceCandidates: new Map([[ETF, prices({ "2026-10-05": 100 })]]),
      }),
    );
    assert.deepEqual(figures(result.months[0]), [cents(100), 10_000, null, 10_000, null]);
  });

  it("a first buy today, €10,010 worth €10,000 this evening: −0.0999% for both, not −100%", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-11",
        to: "2026-11",
        today: "2026-11-15",
        trades: [buy("2026-11-15", ETF, 100, 100, { feesCents: cents(10) })],
        priceCandidates: new Map([[ETF, prices({ "2026-11-15": 100 })]]),
      }),
    );
    assert.deepEqual(figures(result.months[0]), [cents(-10), -999, null, -999, null]);
  });

  it("held through 2024 for +10%, then nothing held through 2025: 10.00% a year for both, in either order", () => {
    const heldFirst = monthlyPerformance(
      input({
        from: "2024-01",
        to: "2025-12",
        trades: [buy("2023-12-01", ETF, 100, 100), sell("2024-12-31", 100, 110)],
        priceCandidates: new Map([[ETF, prices({ "2023-12-01": 100 })]]),
      }),
    );
    assert.deepEqual(
      [heldFirst.totals.gainCents, heldFirst.totals.twrE6, heldFirst.totals.twrAnnualized, heldFirst.totals.mwrE6, heldFirst.totals.mwrAnnualized],
      [cents(1_000), 100_000, true, 100_000, true],
    );
    assert.deepEqual(figures(heldFirst.months[23]), [0, null, "no_capital", null, "no_capital"]);
    const heldLast = monthlyPerformance(
      input({
        from: "2024-01",
        to: "2025-12",
        trades: [buy("2024-12-31", ETF, 100, 100)],
        priceCandidates: new Map([[ETF, prices({ "2024-12-31": 100, "2025-12-31": 110 })]]),
      }),
    );
    assert.deepEqual(
      [heldLast.totals.gainCents, heldLast.totals.twrE6, heldLast.totals.twrAnnualized, heldLast.totals.mwrE6, heldLast.totals.mwrAnnualized],
      [cents(1_000), 100_000, true, 100_000, true],
    );
  });

  it("a €5 fee after the final sale: the range's MWR is about 0.95%, not no_solution, and the gain the months' sum", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-11",
        today: "2026-12-10",
        trades: [buy("2026-09-01", ETF, 100, 100), sell("2026-09-30", 100, 101), fee("2026-10-15", 5)],
        priceCandidates: new Map([[ETF, prices({ "2026-09-01": 100 })]]),
      }),
    );
    // The figure returns.test.ts computes apart: −10,000 (1 + R) + 10,100 − 5 (1 + R)^(−15/29) = 0.
    assert.deepEqual(figures(result.totals), [cents(95), 10_000, null, 9_502, null]);
    assert.deepEqual(
      result.months.map((row) => figures(row)),
      [
        [cents(100), 10_000, null, 10_000, null],
        [cents(-5), null, "no_capital", null, "no_capital"],
        [0, null, "no_capital", null, "no_capital"],
      ],
    );
  });
});

describe("monthlyPerformance: dates", () => {
  it("values the current month at today, leaving out later trades", () => {
    const result = monthlyPerformance(
      input({
        from: "2026-11",
        to: "2026-11",
        today: "2026-11-15",
        trades: [buy("2026-08-03", ETF, 10, 100), buy("2026-11-20", ETF, 10, 100)],
        priceCandidates: new Map([[ETF, prices({ "2026-08-03": 100, "2026-11-10": 110 })]]),
      }),
    );
    assert.equal(result.months[0]?.valuationDate, "2026-11-15");
    assert.equal(result.months[0]?.valueCents, cents(1_100));
    assert.equal(result.months[0]?.netContributionsCents, 0);
    assert.equal(result.months[0]?.twrE6, 100_000);
    assert.equal(result.totals.endDate, "2026-11-15");
  });

  it("a month before anything was held is worth 0 with unknown returns", () => {
    const result = monthlyPerformance(input({ from: "2026-07", to: "2026-07", trades: [buy("2026-08-03", ETF, 10, 100)] }));
    assert.deepEqual(
      [result.months[0]?.valueCents, result.months[0]?.gainCents, result.months[0]?.twrE6, result.months[0]?.mwrE6],
      [0, 0, null, null],
    );
    assert.equal(result.months[0]?.twrUnknownReason, "no_capital");
    assert.equal(result.months[0]?.mwrUnknownReason, "no_capital");
  });

  it("a first buy within the month starts the TWR from nothing", () => {
    // The domain guide: €10,000 on 10 September, €9,995 that evening, €10,150 on 30 September: 1.50%.
    const result = monthlyPerformance(
      input({
        from: "2026-09",
        to: "2026-09",
        trades: [buy("2026-09-10", ETF, 100, 100)],
        priceCandidates: new Map([[ETF, prices({ "2026-09-10": 99.95, "2026-09-30": 101.5 })]]),
      }),
    );
    assert.equal(result.months[0]?.twrE6, 15_000);
    assert.equal(result.months[0]?.gainCents, cents(150));
  });

  it("a range of more than a year gives yearly totals", () => {
    const result = monthlyPerformance(
      input({
        from: "2025-01",
        to: "2026-06",
        trades: [buy("2024-12-02", ETF, 100, 100)],
        priceCandidates: new Map([[ETF, prices({ "2024-12-02": 100, "2026-06-30": 121 })]]),
      }),
    );
    assert.equal(result.months.length, 18);
    assert.equal(result.totals.twrAnnualized, true);
    assert.equal(result.totals.mwrAnnualized, true);
    // 1.21 over 18 months (2024-12-31 to 2026-06-30, 1 + 181/365 years).
    const years = 1 + 181 / 365;
    assert.equal(result.totals.twrE6, Math.round((Math.pow(1.21, 1 / years) - 1) * 1e6));
  });

  it("lastDayOfMonth knows leap years", () => {
    assert.equal(lastDayOfMonth("2024-02"), "2024-02-29");
    assert.equal(lastDayOfMonth("2026-02"), "2026-02-28");
    assert.equal(lastDayOfMonth("2026-12"), "2026-12-31");
  });
});

describe("assertPerformanceRange", () => {
  const today = "2026-11-15";

  it("accepts up to the current month and up to the maximum length", () => {
    assertPerformanceRange("2026-11", "2026-11", today);
    assertPerformanceRange("2016-12", "2026-11", today);
    assert.equal(MAX_PERFORMANCE_MONTHS, 120);
  });

  it("refuses a malformed or missing month, naming the field", () => {
    throwsCode(() => assertPerformanceRange("2026-13", "2026-11", today), "invalid_month", { field: "from", value: "2026-13" });
    throwsCode(() => assertPerformanceRange("2026-01", "2026-1", today), "invalid_month", { field: "to", value: "2026-1" });
    throwsCode(() => assertPerformanceRange(undefined, "2026-11", today), "invalid_month", { field: "from", value: null });
    throwsCode(() => assertPerformanceRange("2026-01", ["2026-02", "2026-03"], today), "invalid_month", {
      field: "to",
      value: "2026-02,2026-03",
    });
  });

  it("refuses to before from, and to after the current month", () => {
    throwsCode(() => assertPerformanceRange("2026-05", "2026-04", today), "invalid_month", { field: "to", value: "2026-04" });
    throwsCode(() => assertPerformanceRange("2026-05", "2026-12", today), "invalid_month", {
      field: "to",
      value: "2026-12",
      max: "2026-11",
    });
  });

  it("refuses more than 120 months", () => {
    throwsCode(() => assertPerformanceRange("2016-11", "2026-11", today), "range_too_long", { months: 121, max: 120 });
  });

  it("monthlyPerformance checks the range first", () => {
    throwsCode(() => monthlyPerformance(input({ from: "2026-10", to: "2026-09", trades: [] })), "invalid_month");
  });
});
