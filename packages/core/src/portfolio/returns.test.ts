import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { ExternalFlow, RateOutcome, Valuation } from "./returns.ts";
import { DAYS_PER_YEAR, moneyWeightedRate, moneyWeightedReturn, timeWeightedRate, timeWeightedReturn } from "./returns.ts";

const TOLERANCE = 1e-9;

/** €x as cents. */
function eur(amount: number): number {
  return Math.round(amount * 100);
}

function value(date: string, amount: number | null): Valuation {
  return { date, valueCents: amount === null ? null : eur(amount) };
}

function flow(date: string, amount: number | null): ExternalFlow {
  return { date, amountCents: amount === null ? null : eur(amount) };
}

function assertRate(outcome: RateOutcome, expected: number, annualized: boolean): void {
  assert.equal(outcome.status, "known", JSON.stringify(outcome));
  if (outcome.status !== "known") return;
  assert.ok(Math.abs(outcome.rate - expected) < TOLERANCE, `rate ${outcome.rate}, expected ${expected}`);
  assert.equal(outcome.annualized, annualized);
}

/** Modified Dietz, flows at the end of their day: the method these returns do NOT use, as a counterexample. */
function modifiedDietz(startValue: number, endValue: number, flows: readonly (readonly [day: number, amount: number])[], days: number): number {
  const total = flows.reduce((sum, [, amount]) => sum + amount, 0);
  const weighted = flows.reduce((sum, [day, amount]) => sum + (amount * (days - day)) / days, 0);
  return (endValue - startValue - total) / (startValue + weighted);
}

// The domain expert's worked examples (#87, 2026-11-22).
const SEPTEMBER = {
  start: value("2025-08-31", 10_000),
  valuations: [value("2025-09-10", 12_100), value("2025-09-30", 12_300)],
  flows: [flow("2025-09-10", 2_000)],
};
const OCTOBER = {
  start: value("2025-09-30", 12_300),
  valuations: [value("2025-10-15", 12_250), value("2025-10-31", 12_100)],
  flows: [flow("2025-10-15", -50)],
};

describe("timeWeightedReturn: the worked examples", () => {
  it("a buy of €2,000 on 10 September: 1.00% to that evening, 1.6529% to the month end, 2.6694% for September", () => {
    assertRate(timeWeightedRate({ start: SEPTEMBER.start, valuations: [value("2025-09-10", 12_100)], flows: SEPTEMBER.flows }), 0.01, false);
    assertRate(timeWeightedRate({ start: value("2025-09-10", 12_100), valuations: [value("2025-09-30", 12_300)], flows: [] }), 12_300 / 12_100 - 1, false);
    assertRate(timeWeightedRate(SEPTEMBER), 1.01 * (12_300 / 12_100) - 1, false);
    assert.deepEqual(timeWeightedReturn(SEPTEMBER), { status: "known", returnE6: 26694, annualized: false });
  });

  it("a net dividend of €50 on 15 October: 0 to that evening, −1.2245% for October", () => {
    assertRate(timeWeightedRate({ start: OCTOBER.start, valuations: [value("2025-10-15", 12_250)], flows: OCTOBER.flows }), 0, false);
    assertRate(timeWeightedRate(OCTOBER), 12_100 / 12_250 - 1, false);
    assert.deepEqual(timeWeightedReturn(OCTOBER), { status: "known", returnE6: -12245, annualized: false });
  });

  it("September and October in one call, cut at the month end: 1.4122%, the two months linked", () => {
    const both = {
      start: SEPTEMBER.start,
      valuations: [...SEPTEMBER.valuations, ...OCTOBER.valuations],
      flows: [...OCTOBER.flows, ...SEPTEMBER.flows],
    };
    const september = timeWeightedRate(SEPTEMBER);
    const october = timeWeightedRate(OCTOBER);
    assert.ok(september.status === "known" && october.status === "known");
    assertRate(timeWeightedRate(both), (1 + september.rate) * (1 + october.rate) - 1, false);
    assert.deepEqual(timeWeightedReturn(both), { status: "known", returnE6: 14122, annualized: false });
  });

  it("from inception: a buy of €10,000 worth €9,995 that evening and €10,150 on 30 September is 1.50%", () => {
    const inception = {
      start: value("2025-08-31", 0),
      valuations: [value("2025-09-10", 9_995), value("2025-09-30", 10_150)],
      flows: [flow("2025-09-10", 10_000)],
    };
    assertRate(timeWeightedRate(inception), 0.015, false);
    assert.deepEqual(timeWeightedReturn(inception), { status: "known", returnE6: 15000, annualized: false });
  });

  it("over 30 days, €10,000 growing to €10,100 is 1.00%, not a yearly rate", () => {
    const period = { start: value("2026-09-01", 10_000), valuations: [value("2026-10-01", 10_100)], flows: [] };
    assertRate(timeWeightedRate(period), 0.01, false);
  });
});

describe("timeWeightedReturn is not Modified Dietz", () => {
  it("from inception on 10 September: Modified Dietz would give 2.25%, the true time-weighted return is 1.50%", () => {
    assert.ok(Math.abs(modifiedDietz(0, 1_015_000, [[10, 1_000_000]], 30) - 0.0225) < TOLERANCE);
    const outcome = timeWeightedReturn({
      start: value("2025-08-31", 0),
      valuations: [value("2025-09-10", 9_995), value("2025-09-30", 10_150)],
      flows: [flow("2025-09-10", 10_000)],
    });
    assert.deepEqual(outcome, { status: "known", returnE6: 15000, annualized: false });
  });

  it("from inception on 20 September: Modified Dietz would give 4.50%, the true time-weighted return is still 1.50%", () => {
    assert.ok(Math.abs(modifiedDietz(0, 1_015_000, [[20, 1_000_000]], 30) - 0.045) < TOLERANCE);
    const outcome = timeWeightedReturn({
      start: value("2025-08-31", 0),
      valuations: [value("2025-09-20", 10_000), value("2025-09-30", 10_150)],
      flows: [flow("2025-09-20", 10_000)],
    });
    assert.deepEqual(outcome, { status: "known", returnE6: 15000, annualized: false });
  });

  it("in September: Modified Dietz would give 2.6471%, the true time-weighted return is 2.6694%", () => {
    assert.ok(Math.abs(modifiedDietz(1_000_000, 1_230_000, [[10, 200_000]], 30) - 0.45 / 17) < TOLERANCE);
    assert.deepEqual(timeWeightedReturn(SEPTEMBER), { status: "known", returnE6: 26694, annualized: false });
  });
});

describe("timeWeightedReturn: periods and edge cases", () => {
  it("a period that starts from nothing measures its length from the first flow, and empty sub-periods add 0", () => {
    // Opened on 1 January 2025, first buy on 1 March 2025, valued on 31 December 2025: 305 days invested.
    const outcome = timeWeightedRate({
      start: value("2024-12-31", 0),
      valuations: [value("2025-01-31", 0), value("2025-03-01", 1_000), value("2025-12-31", 1_100)],
      flows: [flow("2025-03-01", 1_000)],
    });
    assertRate(outcome, 0.1, false);
  });

  it("a period of 365 days or more is a yearly rate: (1 + R)^(365 ÷ days) − 1", () => {
    assertRate(timeWeightedRate({ start: value("2025-01-01", 10_000), valuations: [value("2026-01-01", 11_000)], flows: [] }), 0.1, true);
    const twoYears = timeWeightedRate({ start: value("2024-01-01", 10_000), valuations: [value("2026-01-01", 12_100)], flows: [] });
    assertRate(twoYears, Math.pow(1.21, DAYS_PER_YEAR / 731) - 1, true);
    // 364 days is still the period's own figure.
    assertRate(timeWeightedRate({ start: value("2025-01-01", 10_000), valuations: [value("2025-12-31", 11_000)], flows: [] }), 0.1, false);
  });

  it("several flows on one date add up, and a value-only cut changes nothing", () => {
    const split = timeWeightedRate({
      start: value("2025-08-31", 10_000),
      valuations: [value("2025-09-10", 12_100), value("2025-09-20", 12_200), value("2025-09-30", 12_300)],
      flows: [flow("2025-09-10", 1_500), flow("2025-09-10", 500)],
    });
    assertRate(split, 1.01 * (12_300 / 12_100) - 1, false);
  });

  it("selling everything and buying back later links through the empty days", () => {
    const outcome = timeWeightedRate({
      start: value("2025-08-31", 10_000),
      valuations: [value("2025-09-05", 0), value("2025-09-15", 0), value("2025-09-20", 5_000), value("2025-09-30", 5_100)],
      flows: [flow("2025-09-05", -10_100), flow("2025-09-20", 5_000)],
    });
    assertRate(outcome, 1.01 * 1.02 - 1, false);
  });

  it("a value of €0.00 is a value, not an unknown: a total loss is −100%", () => {
    assertRate(timeWeightedRate({ start: value("2025-08-31", 10_000), valuations: [value("2025-09-30", 0)], flows: [] }), -1, false);
  });

  it("a missing value or flow makes the return unknown, never 0", () => {
    assert.deepEqual(timeWeightedReturn({ ...SEPTEMBER, start: value("2025-08-31", null) }), { status: "unknown", reason: "missing_value" });
    assert.deepEqual(
      timeWeightedReturn({ ...SEPTEMBER, valuations: [value("2025-09-10", null), value("2025-09-30", 12_300)] }),
      { status: "unknown", reason: "missing_value" },
    );
    assert.deepEqual(
      timeWeightedReturn({ ...SEPTEMBER, flows: [flow("2025-09-10", 1_500), flow("2025-09-10", null)] }),
      { status: "unknown", reason: "missing_value" },
    );
  });

  it("no money ever in the portfolio, more taken out than held, or a value from nothing: no_capital", () => {
    const never = { start: value("2025-08-31", 0), valuations: [value("2025-09-30", 0)], flows: [] };
    assert.deepEqual(timeWeightedReturn(never), { status: "unknown", reason: "no_capital" });
    const overdrawn = { start: value("2025-08-31", 1_000), valuations: [value("2025-09-10", 500)], flows: [flow("2025-09-10", 600)] };
    assert.deepEqual(timeWeightedReturn(overdrawn), { status: "unknown", reason: "no_capital" });
    const fromNothing = { start: value("2025-08-31", 0), valuations: [value("2025-09-30", 100)], flows: [] };
    assert.deepEqual(timeWeightedReturn(fromNothing), { status: "unknown", reason: "no_capital" });
    const outFromNothing = { start: value("2025-08-31", 0), valuations: [value("2025-09-30", 0)], flows: [flow("2025-09-30", -100)] };
    assert.deepEqual(timeWeightedReturn(outFromNothing), { status: "unknown", reason: "no_capital" });
  });

  it("refuses valuations out of order, a period with no valuation and a flow with no valuation on its date", () => {
    const refusals = [
      { start: value("2025-08-31", 1_000), valuations: [], flows: [] },
      { start: value("2025-08-31", 1_000), valuations: [value("2025-08-31", 1_000)], flows: [] },
      { start: value("2025-08-31", 1_000), valuations: [value("2025-09-30", 1_000), value("2025-09-10", 1_000)], flows: [] },
      { start: value("2025-08-31", 1_000), valuations: [value("2025-09-30", 1_000)], flows: [flow("2025-09-10", 100)] },
      { start: value("2025-08-31", 1_000), valuations: [value("2025-09-30", 1_000)], flows: [flow("2025-08-31", 100)] },
      { start: value("2025-08-31", 1_000), valuations: [value("2025-09-30", 1_000)], flows: [flow("2025-10-01", 100)] },
      { start: value("2025-02-30", 1_000), valuations: [value("2025-09-30", 1_000)], flows: [] },
    ];
    for (const input of refusals) {
      assert.throws(() => timeWeightedReturn(input), (error) => isValidationError(error) && error.code === "invalid_date", JSON.stringify(input));
    }
  });

  it("refuses a negative value and an amount that is not a safe integer", () => {
    const refusals = [
      { start: { date: "2025-08-31", valueCents: -1 }, valuations: [value("2025-09-30", 1_000)], flows: [] },
      { start: { date: "2025-08-31", valueCents: 0.5 }, valuations: [value("2025-09-30", 1_000)], flows: [] },
      { start: value("2025-08-31", 1_000), valuations: [value("2025-09-30", 1_000)], flows: [{ date: "2025-09-30", amountCents: Number.MAX_SAFE_INTEGER + 1 }] },
    ];
    for (const input of refusals) {
      assert.throws(() => timeWeightedReturn(input), (error) => isValidationError(error) && error.code === "invalid_amount", JSON.stringify(input));
    }
  });

  it("rounds once to millionths, symmetrically for losses, and never gives −0", () => {
    const period = (end: number) => ({ start: { date: "2025-08-31", valueCents: 1_000_000 }, valuations: [{ date: "2025-09-30", valueCents: end }], flows: [] });
    assert.deepEqual(timeWeightedReturn(period(1_000_015)), { status: "known", returnE6: 15, annualized: false });
    assert.deepEqual(timeWeightedReturn(period(999_985)), { status: "known", returnE6: -15, annualized: false });
    // −0.1 millionths rounds to 0, not −0.
    const tiny = timeWeightedReturn({ start: { date: "2025-08-31", valueCents: 10_000_000 }, valuations: [{ date: "2025-09-30", valueCents: 9_999_999 }], flows: [] });
    assert.ok(tiny.status === "known" && Object.is(tiny.returnE6, 0));
  });
});

describe("moneyWeightedReturn (XIRR)", () => {
  it("€10,000 on 1 January 2025, €5,000 on 1 July 2025, €16,000 back on 1 January 2026: 8.02% a year", () => {
    // From inception: the start value is 0 and the first payment is a flow.
    const inception = moneyWeightedRate({
      start: value("2024-12-31", 0),
      end: value("2026-01-01", 16_000),
      flows: [flow("2025-01-01", 10_000), flow("2025-07-01", 5_000)],
    });
    assertRate(inception, 0.0801773600129193, true);
    // The same money as a start value paid in on the start date.
    const fromValue = moneyWeightedRate({ start: value("2025-01-01", 10_000), end: value("2026-01-01", 16_000), flows: [flow("2025-07-01", 5_000)] });
    assertRate(fromValue, 0.0801773600129193, true);
    assert.deepEqual(moneyWeightedReturn({ start: value("2025-01-01", 10_000), end: value("2026-01-01", 16_000), flows: [flow("2025-07-01", 5_000)] }), {
      status: "known",
      returnE6: 80177,
      annualized: true,
    });
  });

  it("over 30 days, €10,000 growing to €10,100 is 1.00%: (1 + r)^(days ÷ 365) − 1", () => {
    const outcome = moneyWeightedRate({ start: value("2026-09-01", 10_000), end: value("2026-10-01", 10_100), flows: [] });
    assertRate(outcome, 0.01, false);
    assert.deepEqual(moneyWeightedReturn({ start: value("2026-09-01", 10_000), end: value("2026-10-01", 10_100), flows: [] }), {
      status: "known",
      returnE6: 10000,
      annualized: false,
    });
  });

  it("matches the time-weighted return when there is no flow", () => {
    const period = { start: value("2025-01-01", 10_000), end: value("2026-01-01", 11_000), flows: [] };
    assertRate(moneyWeightedRate(period), 0.1, true);
  });

  it("a sale before the end is money the household gets back", () => {
    // −10,000 on 1 Jan 2025, +5,250 on 1 Jan 2026, +5,512.50 on 1 Jan 2027: 5% a year.
    const outcome = moneyWeightedRate({
      start: value("2025-01-01", 10_000),
      end: value("2027-01-01", 5_512.5),
      flows: [flow("2026-01-01", -5_250)],
    });
    assertRate(outcome, 0.05, true);
  });

  it("no rate between −99% and +1000% a year: no_solution", () => {
    // Doubling in one day is far beyond +1000% a year.
    assert.deepEqual(moneyWeightedReturn({ start: value("2025-01-01", 10_000), end: value("2025-01-02", 20_000), flows: [] }), {
      status: "unknown",
      reason: "no_solution",
    });
    // A total loss is −100%, outside the bounds.
    assert.deepEqual(moneyWeightedReturn({ start: value("2025-01-01", 10_000), end: value("2026-01-01", 0), flows: [] }), {
      status: "unknown",
      reason: "no_solution",
    });
  });

  it("the household never paid anything in: no_capital", () => {
    assert.deepEqual(moneyWeightedReturn({ start: value("2025-01-01", 0), end: value("2026-01-01", 0), flows: [] }), {
      status: "unknown",
      reason: "no_capital",
    });
    assert.deepEqual(moneyWeightedReturn({ start: value("2025-01-01", 0), end: value("2026-01-01", 100), flows: [] }), {
      status: "unknown",
      reason: "no_capital",
    });
  });

  it("a missing value or flow makes the return unknown, never 0", () => {
    const base = { start: value("2025-01-01", 10_000), end: value("2026-01-01", 16_000), flows: [flow("2025-07-01", 5_000)] };
    for (const input of [
      { ...base, start: value("2025-01-01", null) },
      { ...base, end: value("2026-01-01", null) },
      { ...base, flows: [flow("2025-07-01", null)] },
    ]) {
      assert.deepEqual(moneyWeightedReturn(input), { status: "unknown", reason: "missing_value" });
    }
  });

  it("refuses an end not after the start and a flow outside the period", () => {
    for (const input of [
      { start: value("2025-01-01", 10_000), end: value("2025-01-01", 10_000), flows: [] },
      { start: value("2025-01-01", 10_000), end: value("2026-01-01", 10_000), flows: [flow("2025-01-01", 1)] },
      { start: value("2025-01-01", 10_000), end: value("2026-01-01", 10_000), flows: [flow("2026-01-02", 1)] },
    ]) {
      assert.throws(() => moneyWeightedReturn(input), (error) => isValidationError(error) && error.code === "invalid_date", JSON.stringify(input));
    }
  });
});
