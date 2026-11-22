import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { amountOf, PRICE_FACTOR_HUNDREDTH, PRICE_FACTOR_ONE, toPrice, toQuantity } from "../portfolio/quantity.ts";
import type { Conversion, FxRate } from "./fx.ts";
import { convertAmount, convertSum, fxRateTable, rateOn, valueIn } from "./fx.ts";

/** A stored rate from its published decimal text: rate("USD", "2026-11-20", "1.0812"). Only for readable test data. */
function rate(quote: string, date: string, published: string): FxRate {
  const [whole = "0", fraction = ""] = published.split(".");
  return { base: "EUR", quote, date, rateE10: Number(BigInt(whole + fraction.padEnd(10, "0"))) };
}

/** The rates of the domain expert's examples, published on Friday 20 November 2026. */
const RATES = fxRateTable([
  rate("USD", "2026-11-18", "1.0790"),
  rate("USD", "2026-11-19", "1.0801"),
  rate("USD", "2026-11-20", "1.0812"),
  rate("JPY", "2026-11-20", "162.53"),
  rate("GBP", "2026-11-19", "0.8450"),
  rate("KWD", "2026-11-20", "0.3312"),
]);

const FRIDAY = "2026-11-20";

function known(conversion: Conversion): { cents: number; rateDate: string | null } {
  assert.equal(conversion.status, "known", JSON.stringify(conversion));
  if (conversion.status !== "known") throw new Error("unreachable");
  return { cents: conversion.cents, rateDate: conversion.rateDate };
}

describe("convertAmount: the domain expert's examples", () => {
  it("¥10,000 at 162.53 is €61.53", () => {
    assert.deepEqual(known(convertAmount(10_000, "JPY", "EUR", FRIDAY, RATES)), { cents: 6153, rateDate: FRIDAY });
  });

  it("$1,080.00 at 1.0812 is €998.89", () => {
    assert.deepEqual(known(convertAmount(108_000, "USD", "EUR", FRIDAY, RATES)), { cents: 99_889, rateDate: FRIDAY });
  });

  it("$3,000.00 at 1.0812 is €2,774.69", () => {
    assert.deepEqual(known(convertAmount(300_000, "USD", "EUR", FRIDAY, RATES)), { cents: 277_469, rateDate: FRIDAY });
  });

  it("£1,000.00 to dollars, GBP 0.8450 and USD 1.0812, is $1,279.53: the cross rate is never rounded", () => {
    // A cross rate rounded to four decimals (1.2795) would give $1,279.50.
    const result = known(convertAmount(100_000, "GBP", "USD", FRIDAY, RATES));
    assert.equal(result.cents, 127_953);
  });
});

describe("convertAmount: rounding once, half away from zero", () => {
  // JPY 200: ¥1 is exactly half a cent.
  const HALF = fxRateTable([rate("JPY", FRIDAY, "200"), rate("GBP", FRIDAY, "2"), rate("USD", FRIDAY, "1")]);

  it("rounds an exact half away from zero, either sign", () => {
    assert.equal(known(convertAmount(1, "JPY", "EUR", FRIDAY, HALF)).cents, 1);
    assert.equal(known(convertAmount(-1, "JPY", "EUR", FRIDAY, HALF)).cents, -1);
    assert.equal(known(convertAmount(3, "JPY", "EUR", FRIDAY, HALF)).cents, 2);
    assert.equal(known(convertAmount(-3, "JPY", "EUR", FRIDAY, HALF)).cents, -2);
  });

  it("rounds just under a half toward zero", () => {
    const justOver200 = fxRateTable([rate("JPY", FRIDAY, "200.0000001")]);
    assert.equal(known(convertAmount(1, "JPY", "EUR", FRIDAY, justOver200)).cents, 0);
    assert.equal(known(convertAmount(-1, "JPY", "EUR", FRIDAY, justOver200)).cents, 0);
  });

  it("rounds an exact half of a cross rate away from zero", () => {
    // £0.01 at GBP 2 and USD 1 is half a cent.
    assert.equal(known(convertAmount(1, "GBP", "USD", FRIDAY, HALF)).cents, 1);
    assert.equal(known(convertAmount(-1, "GBP", "USD", FRIDAY, HALF)).cents, -1);
  });

  it("converts a negative amount symmetrically", () => {
    assert.equal(known(convertAmount(-108_000, "USD", "EUR", FRIDAY, RATES)).cents, -99_889);
  });

  it("converts zero to zero", () => {
    assert.equal(known(convertAmount(0, "USD", "EUR", FRIDAY, RATES)).cents, 0);
  });

  it("follows each currency's ISO 4217 decimals", () => {
    // €100.00 at KWD 0.3312 is KWD 33.120 (three decimals); at JPY 162.53, ¥16,253 (none).
    assert.equal(known(convertAmount(10_000, "EUR", "KWD", FRIDAY, RATES)).cents, 33_120);
    assert.equal(known(convertAmount(10_000, "EUR", "JPY", FRIDAY, RATES)).cents, 16_253);
  });

  it("refuses a result beyond the safe range instead of losing precision", () => {
    const max = Number.MAX_SAFE_INTEGER;
    assert.throws(() => convertAmount(max, "EUR", "JPY", FRIDAY, RATES), (error) => isValidationError(error, "invalid_amount"));
  });

  it("converts the largest amount that fits", () => {
    // €10,000,000,000.00 (the cap on a single amount) to yen.
    assert.equal(known(convertAmount(1_000_000_000_000, "EUR", "JPY", FRIDAY, RATES)).cents, 1_625_300_000_000);
  });

  it("refuses an amount that is not a safe integer, and an invalid date", () => {
    assert.throws(() => convertAmount(1.5, "USD", "EUR", FRIDAY, RATES), (error) => isValidationError(error, "invalid_amount"));
    assert.throws(() => convertAmount(100, "USD", "EUR", "2026-02-30", RATES), (error) => isValidationError(error, "invalid_date"));
  });
});

describe("convertAmount: which rate", () => {
  it("returns the same currency as it is, with no rate, even with no rates at all", () => {
    const none = fxRateTable([]);
    assert.deepEqual(known(convertAmount(12_345, "USD", "USD", FRIDAY, none)), { cents: 12_345, rateDate: null });
    assert.deepEqual(known(convertAmount(12_345, "EUR", "EUR", FRIDAY, none)), { cents: 12_345, rateDate: null });
  });

  it("uses the rate of the date itself when there is one", () => {
    assert.deepEqual(known(convertAmount(107_900, "USD", "EUR", "2026-11-18", RATES)), { cents: 100_000, rateDate: "2026-11-18" });
  });

  it("uses the most recent rate before the date on a weekend", () => {
    assert.deepEqual(known(convertAmount(108_000, "USD", "EUR", "2026-11-22", RATES)), { cents: 99_889, rateDate: FRIDAY });
  });

  it("ignores rates published after the date", () => {
    assert.equal(known(convertAmount(108_000, "USD", "EUR", "2026-11-19", RATES)).rateDate, "2026-11-19");
  });

  it("has no maximum age: a rate years old is used, and its date says so", () => {
    const old = fxRateTable([rate("CHF", "2020-01-02", "1.0854")]);
    assert.deepEqual(known(convertAmount(108_540, "CHF", "EUR", FRIDAY, old)), { cents: 100_000, rateDate: "2020-01-02" });
  });

  it("is unknown, never zero, with no rate on or before the date", () => {
    assert.deepEqual(convertAmount(10_000, "USD", "EUR", "2026-11-17", RATES), {
      status: "unknown",
      reason: "no_rate",
      currencies: ["USD"],
    });
    assert.deepEqual(convertAmount(10_000, "CHF", "EUR", FRIDAY, RATES), { status: "unknown", reason: "no_rate", currencies: ["CHF"] });
  });

  it("names every currency without a rate in a cross conversion", () => {
    assert.deepEqual(convertAmount(10_000, "CHF", "SEK", FRIDAY, RATES), {
      status: "unknown",
      reason: "no_rate",
      currencies: ["CHF", "SEK"],
    });
    assert.deepEqual(convertAmount(10_000, "GBP", "SEK", FRIDAY, RATES), { status: "unknown", reason: "no_rate", currencies: ["SEK"] });
  });

  it("converts from the euro with the target's rate", () => {
    assert.deepEqual(known(convertAmount(100_000, "EUR", "USD", FRIDAY, RATES)), { cents: 108_120, rateDate: FRIDAY });
  });

  it("gives a cross conversion the older of its two rate dates", () => {
    // GBP was last published on the 19th, USD on the 20th.
    assert.equal(known(convertAmount(100_000, "GBP", "USD", "2026-11-22", RATES)).rateDate, "2026-11-19");
    assert.equal(known(convertAmount(100_000, "USD", "GBP", "2026-11-22", RATES)).rateDate, "2026-11-19");
  });
});

describe("rateOn", () => {
  it("gives the euro exactly 1, with no date", () => {
    assert.deepEqual(rateOn(fxRateTable([]), "EUR", FRIDAY), { rateE10: 10_000_000_000, rateDate: null });
  });

  it("finds the most recent rate on or before the date, whatever the input order", () => {
    const shuffled = fxRateTable([rate("USD", "2026-11-20", "1.0812"), rate("USD", "2026-11-18", "1.0790"), rate("USD", "2026-11-19", "1.0801")]);
    assert.deepEqual(rateOn(shuffled, "USD", "2026-11-19"), { rateE10: 10_801_000_000, rateDate: "2026-11-19" });
    assert.deepEqual(rateOn(shuffled, "USD", "2030-01-01"), { rateE10: 10_812_000_000, rateDate: "2026-11-20" });
    assert.equal(rateOn(shuffled, "USD", "2026-11-17"), null);
    assert.equal(rateOn(shuffled, "GBP", FRIDAY), null);
  });

  it("finds the right rate in a long history", () => {
    const history: FxRate[] = [];
    for (let day = 1; day <= 28; day += 3) history.push({ base: "EUR", quote: "USD", date: `2026-02-${String(day).padStart(2, "0")}`, rateE10: day });
    const table = fxRateTable(history);
    for (let day = 1; day <= 28; day++) {
      const expected = day - ((day - 1) % 3);
      assert.equal(rateOn(table, "USD", `2026-02-${String(day).padStart(2, "0")}`)?.rateE10, expected, `day ${day}`);
    }
  });
});

describe("fxRateTable refuses a malformed rate", () => {
  const cases: [string, unknown][] = [
    ["a base other than the euro", { base: "USD", quote: "GBP", date: FRIDAY, rateE10: 1 }],
    ["the euro as quote", { base: "EUR", quote: "EUR", date: FRIDAY, rateE10: 1 }],
    ["a lower-case quote", { base: "EUR", quote: "usd", date: FRIDAY, rateE10: 1 }],
    ["an invalid date", { base: "EUR", quote: "USD", date: "2026-11-31", rateE10: 1 }],
    ["a zero rate", { base: "EUR", quote: "USD", date: FRIDAY, rateE10: 0 }],
    ["a negative rate", { base: "EUR", quote: "USD", date: FRIDAY, rateE10: -10_812_000_000 }],
    ["a fractional rate", { base: "EUR", quote: "USD", date: FRIDAY, rateE10: 1.5 }],
    ["a rate beyond the safe range", { base: "EUR", quote: "USD", date: FRIDAY, rateE10: 2 ** 53 }],
  ];
  for (const [name, value] of cases) {
    it(name, () => {
      assert.throws(() => fxRateTable([value as FxRate]), (error) => isValidationError(error, "invalid_fx_rate"));
    });
  }

  it("two rates for the same currency and date", () => {
    assert.throws(
      () => fxRateTable([rate("USD", FRIDAY, "1.0812"), rate("USD", FRIDAY, "1.0813")]),
      (error) => isValidationError(error, "invalid_fx_rate") && error.details["quote"] === "USD",
    );
  });
});

describe("valueIn", () => {
  it("converts the amount rounded in the instrument's currency, so a line and its total agree", () => {
    // 3 shares at $33.335 are $100.005, rounded to $100.01 (amountOf); at USD 2 that is €50.005, so €50.01.
    // Recomputed from the unrounded product it would be €50.0025, so €50.00, and the line would differ from the total.
    const two = fxRateTable([rate("USD", FRIDAY, "2")]);
    const quantity = toQuantity(300_000_000);
    const price = toPrice(33_335_000);
    const amount = amountOf(quantity, price, PRICE_FACTOR_ONE, "USD");
    assert.equal(amount, 10_001);
    const line = valueIn(quantity, price, PRICE_FACTOR_ONE, "USD", "EUR", FRIDAY, two);
    const total = convertSum([{ cents: amount, currency: "USD" }], "EUR", FRIDAY, two);
    assert.deepEqual(known(line), { cents: 5001, rateDate: FRIDAY });
    assert.deepEqual(known(total), { cents: 5001, rateDate: FRIDAY });
  });

  it("rounds an exact half away from zero in the instrument's own currency", () => {
    // 0.5 units at $0.01 is half a cent: $0.01.
    const value = valueIn(toQuantity(50_000_000), toPrice(10_000), PRICE_FACTOR_ONE, "USD", "USD", FRIDAY, fxRateTable([]));
    assert.deepEqual(known(value), { cents: 1, rateDate: null });
  });

  it("values 10 shares at $100.50 in euros", () => {
    // $1,005.00 ÷ 1.0812 = €929.5227…
    const value = valueIn(toQuantity(1_000_000_000), toPrice(100_500_000), PRICE_FACTOR_ONE, "USD", "EUR", FRIDAY, RATES);
    assert.deepEqual(known(value), { cents: 92_952, rateDate: FRIDAY });
  });

  it("applies a price factor", () => {
    // $10,000 nominal at 98.765432% is $9,876.5432, so $9,876.54; ÷ 1.0812 = €9,134.79…
    const value = valueIn(toQuantity(1_000_000_000_000), toPrice(98_765_432), PRICE_FACTOR_HUNDREDTH, "USD", "EUR", FRIDAY, RATES);
    assert.equal(known(value).cents, 913_479);
  });

  it("equals amountOf in the instrument's own currency, with no rate", () => {
    const quantity = toQuantity(1_000_000_000_000);
    const price = toPrice(98_765_432);
    const value = valueIn(quantity, price, PRICE_FACTOR_HUNDREDTH, "USD", "USD", FRIDAY, fxRateTable([]));
    assert.deepEqual(known(value), { cents: amountOf(quantity, price, PRICE_FACTOR_HUNDREDTH, "USD"), rateDate: null });
  });

  it("values a short position as a negative amount", () => {
    const value = valueIn(toQuantity(-1_000_000_000), toPrice(100_500_000), PRICE_FACTOR_ONE, "USD", "EUR", FRIDAY, RATES);
    assert.equal(known(value).cents, -92_952);
  });

  it("is unknown with no rate", () => {
    const value = valueIn(toQuantity(100_000_000), toPrice(1_000_000), PRICE_FACTOR_ONE, "CHF", "EUR", FRIDAY, RATES);
    assert.deepEqual(value, { status: "unknown", reason: "no_rate", currencies: ["CHF"] });
  });

  it("refuses a value beyond the safe range", () => {
    const value = (): Conversion =>
      valueIn(toQuantity(Number.MAX_SAFE_INTEGER), toPrice(Number.MAX_SAFE_INTEGER), PRICE_FACTOR_ONE, "EUR", "JPY", FRIDAY, RATES);
    assert.throws(value, (error) => isValidationError(error, "invalid_amount"));
  });
});

describe("convertSum", () => {
  it("adds up in each currency first, then converts once", () => {
    // At USD 2, each $0.01 is half a cent: converted one by one, three of them would be €0.03.
    const two = fxRateTable([rate("USD", FRIDAY, "2")]);
    const cents = [1, 1, 1].map((c) => ({ cents: c, currency: "USD" }));
    assert.deepEqual(known(convertSum(cents, "EUR", FRIDAY, two)), { cents: 2, rateDate: FRIDAY });
  });

  it("adds amounts in several currencies, the target's as they are", () => {
    // The GBP amount, with the oldest rate, comes first, so keeping the last rate date would not pass.
    const amounts = [
      { cents: 100_000, currency: "GBP" },
      { cents: 10_000, currency: "EUR" },
      { cents: 108_000, currency: "USD" },
      { cents: 10_000, currency: "JPY" },
    ];
    // £1,000.00 ÷ 0.8450 (€1,183.43) + €100.00 + €998.89 + €61.53, oldest rate the GBP one.
    assert.deepEqual(known(convertSum(amounts, "EUR", "2026-11-22", RATES)), { cents: 10_000 + 99_889 + 6153 + 118_343, rateDate: "2026-11-19" });
  });

  it("uses no rate when every amount is in the target currency, and gives 0 for no amounts", () => {
    assert.deepEqual(known(convertSum([{ cents: 5, currency: "USD" }], "USD", FRIDAY, fxRateTable([]))), { cents: 5, rateDate: null });
    assert.deepEqual(known(convertSum([], "EUR", FRIDAY, RATES)), { cents: 0, rateDate: null });
  });

  it("is unknown, never a partial sum, when any currency has no rate", () => {
    const amounts = [
      { cents: 10_000, currency: "EUR" },
      { cents: 100, currency: "SEK" },
      { cents: 100, currency: "CHF" },
    ];
    assert.deepEqual(convertSum(amounts, "EUR", FRIDAY, RATES), { status: "unknown", reason: "no_rate", currencies: ["CHF", "SEK"] });
  });

  it("lists the target itself when the target has no rate, and every other currency is then unconvertible", () => {
    const amounts = [
      { cents: 500, currency: "CHF" },
      { cents: 108_000, currency: "USD" },
    ];
    assert.deepEqual(convertSum(amounts, "CHF", FRIDAY, RATES), { status: "unknown", reason: "no_rate", currencies: ["CHF"] });
  });

  it("adds up beyond the safe range in the source currency when the converted total fits", () => {
    // Two amounts whose yen sum is beyond 2^53 but whose euro total (about 5.5 × 10^15 cents) is not.
    const max = Number.MAX_SAFE_INTEGER;
    const result = convertSum(
      [
        { cents: max, currency: "JPY" },
        { cents: 1, currency: "JPY" },
      ],
      "EUR",
      FRIDAY,
      RATES,
    );
    assert.equal(known(result).cents, 5_541_868_734_843_409);
  });

  it("refuses a total beyond the safe range", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const amounts = [
      { cents: max, currency: "EUR" },
      { cents: max, currency: "EUR" },
    ];
    assert.throws(() => convertSum(amounts, "EUR", FRIDAY, RATES), (error) => isValidationError(error, "amount_total_overflow"));
  });
});
