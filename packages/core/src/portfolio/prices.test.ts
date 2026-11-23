import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { externalFlows } from "./external-flows.ts";
import { computePositions, valuePosition, type PositionTrade } from "./positions.ts";
import { priceSeriesAt, resolvePrice, type PriceCandidate, type PriceOrigin, type ResolvedPrice } from "./prices.ts";
import { ONE_UNIT, PRICE_FACTOR_ONE, toPrice, type Quantity } from "./quantity.ts";
import { moneyWeightedReturn, timeWeightedReturn } from "./returns.ts";

function candidate(priceDate: string, closeE6: number, origin: PriceOrigin): PriceCandidate {
  return { priceDate, closeE6: toPrice(closeE6), origin };
}

describe("resolvePrice", () => {
  it("is unknown, never zero, when there is no candidate", () => {
    assert.equal(resolvePrice([], "2026-03-31"), null);
  });

  it("is unknown when every candidate is dated after the date", () => {
    assert.equal(resolvePrice([candidate("2026-04-01", 101_000000, "shared")], "2026-03-31"), null);
  });

  it("takes a price dated exactly on the date", () => {
    assert.deepEqual(resolvePrice([candidate("2026-03-31", 101_500000, "shared")], "2026-03-31"), {
      closeE6: 101_500000,
      priceDate: "2026-03-31",
      origin: "shared",
    });
  });

  it("takes the latest price on or before the date, whatever the order of the candidates", () => {
    const candidates = [
      candidate("2026-03-27", 100_000000, "shared"),
      candidate("2026-04-02", 104_000000, "shared"),
      candidate("2026-03-30", 102_000000, "shared"),
    ];
    assert.deepEqual(resolvePrice(candidates, "2026-03-31"), { closeE6: 102_000000, priceDate: "2026-03-30", origin: "shared" });
  });

  it("prefers the workspace's own price to the shared one on the same date, in either order", () => {
    const own = candidate("2026-03-31", 99_000000, "own");
    const shared = candidate("2026-03-31", 101_000000, "shared");
    const expected = { closeE6: 99_000000, priceDate: "2026-03-31", origin: "own" };
    assert.deepEqual(resolvePrice([own, shared], "2026-03-31"), expected);
    assert.deepEqual(resolvePrice([shared, own], "2026-03-31"), expected);
    assert.deepEqual(resolvePrice([shared, own], "2026-04-15"), expected);
  });

  it("takes a newer shared price over an older own price", () => {
    const candidates = [candidate("2026-03-20", 99_000000, "own"), candidate("2026-03-30", 101_000000, "shared")];
    assert.deepEqual(resolvePrice(candidates, "2026-03-31"), { closeE6: 101_000000, priceDate: "2026-03-30", origin: "shared" });
    assert.deepEqual(resolvePrice(candidates, "2026-03-25"), { closeE6: 99_000000, priceDate: "2026-03-20", origin: "own" });
  });

  it("takes a newer own price over an older shared price", () => {
    const candidates = [candidate("2026-03-20", 101_000000, "shared"), candidate("2026-03-30", 99_000000, "own")];
    assert.deepEqual(resolvePrice(candidates, "2026-03-31"), { closeE6: 99_000000, priceDate: "2026-03-30", origin: "own" });
  });

  it("keeps a price of zero, which is known", () => {
    assert.deepEqual(resolvePrice([candidate("2026-03-31", 0, "own")], "2026-03-31"), {
      closeE6: 0,
      priceDate: "2026-03-31",
      origin: "own",
    });
  });

  it("keeps the largest safe price exactly", () => {
    const resolved = resolvePrice([candidate("2026-03-31", Number.MAX_SAFE_INTEGER, "shared")], "2026-03-31");
    assert.equal(resolved?.closeE6, Number.MAX_SAFE_INTEGER);
  });

  it("crosses a month and a year boundary", () => {
    const candidates = [candidate("2025-12-31", 100_000000, "shared")];
    assert.deepEqual(resolvePrice(candidates, "2026-01-01"), { closeE6: 100_000000, priceDate: "2025-12-31", origin: "shared" });
    assert.equal(resolvePrice(candidates, "2025-12-30"), null);
  });

  it("refuses a malformed date or candidate", () => {
    assert.throws(() => resolvePrice([], "2026-02-30"), (error) => isValidationError(error, "invalid_date"));
    assert.throws(
      () => resolvePrice([candidate("2026-02-30", 1, "own")], "2026-03-01"),
      (error) => isValidationError(error, "invalid_date"),
    );
    for (const closeE6 of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      assert.throws(
        () => resolvePrice([{ priceDate: "2026-03-01", closeE6: closeE6 as never, origin: "own" }], "2026-03-01"),
        (error) => isValidationError(error, "invalid_price"),
        String(closeE6),
      );
    }
  });

  it("refuses two candidates of the same origin on the same date", () => {
    for (const origin of ["own", "shared"] as const) {
      assert.throws(
        () => resolvePrice([candidate("2026-03-31", 1, origin), candidate("2026-03-31", 2, origin)], "2026-04-30"),
        (error) => isValidationError(error, "duplicate_price") && error.details.date === "2026-03-31" && error.details.origin === origin,
      );
    }
  });
});

describe("priceSeriesAt", () => {
  const candidates = [
    candidate("2026-01-30", 100_000000, "shared"),
    candidate("2026-02-27", 102_000000, "shared"),
    candidate("2026-02-27", 101_000000, "own"),
    candidate("2026-03-31", 103_000000, "shared"),
  ];

  it("resolves every date, in the order given, with the same rule as resolvePrice", () => {
    const dates = ["2026-03-31", "2026-01-15", "2026-02-28", "2026-01-31", "2026-02-28"];
    const series = priceSeriesAt(candidates, dates);
    assert.deepEqual(
      series,
      dates.map((date) => resolvePrice(candidates, date)),
    );
    assert.deepEqual(
      series.map((price) => price?.closeE6 ?? null),
      [103_000000, null, 101_000000, 100_000000, 101_000000],
    );
  });

  it("gives an empty series for no dates, and unknown prices for no candidates", () => {
    assert.deepEqual(priceSeriesAt(candidates, []), []);
    assert.deepEqual(priceSeriesAt([], ["2026-01-31", "2026-02-28"]), [null, null]);
  });

  it("refuses a malformed date", () => {
    assert.throws(() => priceSeriesAt(candidates, ["2026-01-31", "2026-13-01"]), (error) => isValidationError(error, "invalid_date"));
  });
});

describe("a price has no lower date limit (#83)", () => {
  // One buy of 10 units at €100 on 10 March 2025, valued at three own prices; the figures must
  // not change when an old price (1850) or one dated before the buy is added.
  const buy: PositionTrade = {
    id: "buy",
    accountId: "account",
    portfolioId: "portfolio",
    instrumentId: "fund",
    type: "buy",
    date: "2025-03-10",
    occurredAt: "2025-03-10T10:00:00Z",
    createdAt: "2025-03-10T10:00:00Z",
    currency: "EUR",
    quantity: (10 * ONE_UNIT) as Quantity,
    price: toPrice(100_000000),
    priceFactor: PRICE_FACTOR_ONE,
    grossCents: 100_000,
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
  };
  const base = [
    candidate("2025-03-10", 100_000000, "own"),
    candidate("2025-03-31", 105_000000, "own"),
    candidate("2025-04-30", 110_000000, "own"),
  ];
  const start = "2025-02-28";
  const dates = ["2025-03-10", "2025-03-31", "2025-04-30"];

  /** The position's value on each date, and the time- and money-weighted returns from `start` to the last date. */
  function figures(candidates: readonly PriceCandidate[]) {
    const valueOn = (date: string, price: ResolvedPrice | null): number | null => {
      const position = computePositions([buy], { asOf: date }).accounts[0];
      if (position === undefined || position.quantity === 0) return 0;
      return price === null ? null : valuePosition(position, price.closeE6).valueCents;
    };
    const [startPrice = null] = priceSeriesAt(candidates, [start]);
    const startValue = { date: start, valueCents: valueOn(start, startPrice) };
    const valuations = priceSeriesAt(candidates, dates).map((price, index) => ({ date: dates[index]!, valueCents: valueOn(dates[index]!, price) }));
    const flows = externalFlows([buy], () => null);
    return {
      values: valuations.map((valuation) => valuation.valueCents),
      twr: timeWeightedReturn({ start: startValue, valuations, flows }),
      mwr: moneyWeightedReturn({ start: startValue, end: valuations[valuations.length - 1]!, valuations, flows }),
    };
  }

  it("values the position and computes both returns from the prices around the buy", () => {
    const expected = figures(base);
    assert.deepEqual(expected.values, [100_000, 105_000, 110_000]);
    assert.equal(expected.twr.status, "known");
    assert.equal(expected.mwr.status, "known");
  });

  it("a price dated 1850 is a valid price, and changes neither the value nor either return", () => {
    const old = candidate("1850-01-01", 1_000000, "own");
    assert.deepEqual(resolvePrice([old, ...base], "1900-01-01"), { closeE6: 1_000000, priceDate: "1850-01-01", origin: "own" });
    assert.deepEqual(figures([old, ...base]), figures(base));
  });

  it("a price dated before the first buy changes neither the value nor either return", () => {
    const before = candidate("2025-01-15", 50_000000, "own");
    assert.deepEqual(figures([before, ...base]), figures(base));
    assert.deepEqual(figures([candidate("1850-01-01", 1_000000, "shared"), before, ...base]), figures(base));
  });
});
