import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { Price, PriceFactor, Quantity } from "./quantity.ts";
import {
  amountOf,
  assertPrice,
  assertPriceFactor,
  assertQuantity,
  formatPrice,
  formatQuantity,
  ONE_UNIT,
  parsePrice,
  parseQuantity,
  PRICE_FACTOR_HUNDREDTH,
  PRICE_FACTOR_ONE,
  priceFrom,
  proportionalCost,
  quantityFor,
  toPrice,
  toPriceFactor,
  toQuantity,
} from "./quantity.ts";

const IT = { locale: "it-IT" };
const US = { locale: "en-US" };

/** Units as a Quantity: units(1.5) is 150000000. Only for readable test data. */
function units(value: number): Quantity {
  return toQuantity(Math.round(value * 1e8));
}

/** A price as a Price: price(87.123456) is 87123456. Only for readable test data. */
function price(value: number): Price {
  return toPrice(Math.round(value * 1e6));
}

describe("assertQuantity, assertPrice, assertPriceFactor", () => {
  it("accept safe integers in range", () => {
    assertQuantity(0);
    assertQuantity(-150_000_000);
    assertQuantity(Number.MAX_SAFE_INTEGER);
    assertPrice(0);
    assertPrice(Number.MAX_SAFE_INTEGER);
    assertPriceFactor(1);
    assert.equal(toPriceFactor(1_000_000), PRICE_FACTOR_ONE);
  });

  it("reject fractions, NaN and unsafe integers with a stable code", () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53)]) {
      assert.throws(() => assertQuantity(value), (e) => isValidationError(e, "invalid_quantity"), `quantity ${value}`);
      assert.throws(() => assertPrice(value), (e) => isValidationError(e, "invalid_price"), `price ${value}`);
      assert.throws(() => assertPriceFactor(value), (e) => isValidationError(e, "invalid_price_factor"), `factor ${value}`);
    }
  });

  it("reject a negative price and a price factor that is not positive", () => {
    assert.throws(() => assertPrice(-1), (e) => isValidationError(e, "invalid_price"));
    assert.throws(() => assertPriceFactor(0), (e) => isValidationError(e, "invalid_price_factor"));
    assert.throws(() => assertPriceFactor(-10_000), (e) => isValidationError(e, "invalid_price_factor"));
  });
});

describe("parseQuantity", () => {
  it("reads Italian-formatted quantities, decimal comma included", () => {
    assert.equal(parseQuantity("1,14779652", IT), 114_779_652);
    assert.equal(parseQuantity("1.000,5", IT), 100_050_000_000);
    assert.equal(parseQuantity("1000,5", IT), 100_050_000_000);
    assert.equal(parseQuantity("0,00000001", IT), 1);
    assert.equal(parseQuantity(" 12 ", IT), 1_200_000_000);
  });

  it("reads US-formatted quantities", () => {
    assert.equal(parseQuantity("1,000.5", US), 100_050_000_000);
    assert.equal(parseQuantity("1.14779652", US), 114_779_652);
  });

  it("handles negative quantities and normalizes -0", () => {
    assert.equal(parseQuantity("-0,5", IT), -50_000_000);
    assert.ok(Object.is(parseQuantity("-0", IT), 0));
  });

  it("rejects more than 8 decimals and text that does not match the locale", () => {
    for (const text of ["1,123456789", "1.5", "1,234.5", "abc", "", "1,2,3"]) {
      assert.throws(
        () => parseQuantity(text, IT),
        (e) => isValidationError(e, "invalid_quantity_format"),
        `"${text}" should have been rejected`,
      );
    }
  });

  it("accepts the largest safe quantity and rejects one unit × 10^-8 beyond it", () => {
    assert.equal(parseQuantity("90.071.992,54740991", IT), Number.MAX_SAFE_INTEGER);
    assert.throws(() => parseQuantity("90.071.992,54740992", IT), (e) => isValidationError(e, "invalid_quantity"));
    assert.throws(() => parseQuantity("100.000.000", IT), (e) => isValidationError(e, "invalid_quantity"));
  });
});

describe("parsePrice", () => {
  it("reads prices with up to 6 decimals in the user's locale", () => {
    assert.equal(parsePrice("87,123456", IT), 87_123_456);
    assert.equal(parsePrice("98,765432", IT), 98_765_432);
    assert.equal(parsePrice("1.234,5", IT), 1_234_500_000);
    assert.equal(parsePrice("1,234.5", US), 1_234_500_000);
    assert.equal(parsePrice("0", US), 0);
  });

  it("rejects more than 6 decimals, a negative price and an unsafe one", () => {
    assert.throws(() => parsePrice("87,1234567", IT), (e) => isValidationError(e, "invalid_price_format"));
    assert.throws(() => parsePrice("87.12", IT), (e) => isValidationError(e, "invalid_price_format"));
    assert.throws(() => parsePrice("-1", IT), (e) => isValidationError(e, "invalid_price"));
    assert.throws(() => parsePrice("9.007.199.255", IT), (e) => isValidationError(e, "invalid_price"));
  });
});

describe("formatQuantity and formatPrice", () => {
  it("show exactly the decimals a value has, in the user's locale", () => {
    assert.equal(formatQuantity(114_779_652 as Quantity, IT), "1,14779652");
    assert.equal(formatQuantity(100_050_000_000 as Quantity, US), "1,000.5");
    assert.equal(formatQuantity(1 as Quantity, US), "0.00000001");
    assert.equal(formatQuantity(ONE_UNIT, US), "1");
    assert.equal(formatQuantity(-50_000_000 as Quantity, IT), "-0,5");
    assert.equal(formatQuantity(Number.MAX_SAFE_INTEGER as Quantity, US), "90,071,992.54740991");
  });

  it("show a price in its currency with at least the currency's decimals", () => {
    assert.equal(formatPrice(87_123_456 as Price, { locale: "en-US", currency: "EUR" }), "€87.123456");
    assert.equal(formatPrice(87_500_000 as Price, { locale: "it-IT", currency: "EUR" }), "87,50 €");
    assert.equal(formatPrice(1_234_000_000 as Price, { locale: "en-US", currency: "JPY" }), "¥1,234");
    assert.equal(formatPrice(1_234_500_000 as Price, { locale: "en-US", currency: "JPY" }), "¥1,234.5");
  });

  it("show a price without a currency as a plain number (a bond in percent of nominal)", () => {
    assert.equal(formatPrice(98_765_432 as Price, IT), "98,765432");
    assert.equal(formatPrice(100_000_000 as Price, IT), "100");
  });

  it("round-trip with the parsers", () => {
    for (const value of [0, 1, 114_779_652, -50_000_000, 123_456_789_012_345, Number.MAX_SAFE_INTEGER]) {
      for (const options of [IT, US]) {
        assert.equal(parseQuantity(formatQuantity(value as Quantity, options), options), value);
      }
    }
    for (const value of [0, 1, 87_123_456, 98_765_432, 1_234_500_000, Number.MAX_SAFE_INTEGER]) {
      for (const options of [IT, US]) {
        assert.equal(parsePrice(formatPrice(value as Price, options), options), value);
      }
    }
  });
});

describe("amountOf", () => {
  it("multiplies exactly when the product goes beyond 2^53", () => {
    // 10 units at €100: 10^9 × 10^8 × 10^6 × 100 = 10^25 before scaling down.
    assert.equal(amountOf(units(10), price(100), PRICE_FACTOR_ONE, "EUR"), 100_000);
    assert.equal(amountOf(units(1.14779652), price(87.123456), PRICE_FACTOR_ONE, "EUR"), 10_000);
  });

  it("handles about 90 million units at a high price, and rejects an amount beyond the safe range", () => {
    // 90 million units at €1,000,000 = €90 trillion = 9 × 10^15 cents, just below 2^53.
    assert.equal(amountOf(units(90_000_000), price(1_000_000), PRICE_FACTOR_ONE, "EUR"), 9_000_000_000_000_000);
    assert.throws(
      () => amountOf(units(90_000_000), price(1_001_000), PRICE_FACTOR_ONE, "EUR"),
      (e) => isValidationError(e, "invalid_amount"),
    );
  });

  it("rounds half away from zero, once, at the end", () => {
    // 0.5 units at €0.01 = €0.005.
    assert.equal(amountOf(units(0.5), price(0.01), PRICE_FACTOR_ONE, "EUR"), 1);
    assert.equal(amountOf(units(-0.5), price(0.01), PRICE_FACTOR_ONE, "EUR"), -1);
    // Just below the half way: 0.49999999 units at €0.01.
    assert.equal(amountOf(units(0.49999999), price(0.01), PRICE_FACTOR_ONE, "EUR"), 0);
    // 3 units at €0.333333: €0.999999, not 3 × €0.33.
    assert.equal(amountOf(units(3), price(0.333333), PRICE_FACTOR_ONE, "EUR"), 100);
  });

  it("uses the currency's minor unit: no decimals for JPY", () => {
    assert.equal(amountOf(units(3), price(1234.5), PRICE_FACTOR_ONE, "JPY"), 3704);
    assert.equal(amountOf(units(-3), price(1234.5), PRICE_FACTOR_ONE, "JPY"), -3704);
    assert.equal(amountOf(units(2), price(1234.25), PRICE_FACTOR_ONE, "JPY"), 2469);
  });

  it("applies the price factor of a bond quoted in percent of nominal", () => {
    // 10,000 nominal at 98.765432% = €9,876.54 (9,876.5432 rounded).
    assert.equal(amountOf(units(10_000), price(98.765432), PRICE_FACTOR_HUNDREDTH, "EUR"), 987_654);
  });

  it("applies the price factor of an instrument quoted in hundredths of its currency", () => {
    // 100 shares at 1,234.5 pence = £1,234.50.
    assert.equal(amountOf(units(100), price(1234.5), PRICE_FACTOR_HUNDREDTH, "GBP"), 123_450);
  });
});

describe("quantityFor", () => {
  it("rounds toward zero to 8 decimals", () => {
    // A savings plan of €100 at €87.123456: 1.147796525... units.
    assert.equal(quantityFor(10_000, price(87.123456), PRICE_FACTOR_ONE, "EUR"), 114_779_652);
    // €2 at €3 is 0.666666666...: never rounded up.
    assert.equal(quantityFor(200, price(3), PRICE_FACTOR_ONE, "EUR"), 66_666_666);
    assert.equal(quantityFor(-200, price(3), PRICE_FACTOR_ONE, "EUR"), -66_666_666);
    assert.equal(quantityFor(10_000, price(50), PRICE_FACTOR_ONE, "EUR"), units(2));
  });

  it("rounds down to the step when only whole or coarser units can be bought", () => {
    assert.equal(quantityFor(10_000, price(87.123456), PRICE_FACTOR_ONE, "EUR", units(0.001)), units(1.147));
    assert.equal(quantityFor(10_000, price(87.123456), PRICE_FACTOR_ONE, "EUR", ONE_UNIT), units(1));
    assert.equal(quantityFor(8_000, price(87.123456), PRICE_FACTOR_ONE, "EUR", ONE_UNIT), 0);
  });

  it("applies the price factor and the currency's minor unit", () => {
    assert.equal(quantityFor(987_654, price(98.765432), PRICE_FACTOR_HUNDREDTH, "EUR"), 999_999_675_999);
    assert.equal(quantityFor(3704, price(1234.5), PRICE_FACTOR_ONE, "JPY"), 300_040_502);
  });

  it("never spends more than the amount", () => {
    const prices = [price(0.01), price(0.333333), price(3), price(87.123456), price(1234.5), price(999_999.999999)];
    for (const p of prices) {
      for (const amount of [1, 99, 10_000, 12_345_678]) {
        const quantity = quantityFor(amount, p, PRICE_FACTOR_ONE, "EUR");
        assert.ok(amountOf(quantity, p, PRICE_FACTOR_ONE, "EUR") <= amount, `${amount} at ${p}`);
      }
    }
  });

  it("rejects a price of zero, a step that is not positive and a quantity beyond the safe range", () => {
    assert.throws(() => quantityFor(10_000, 0 as Price, PRICE_FACTOR_ONE, "EUR"), (e) => isValidationError(e, "invalid_price"));
    assert.throws(
      () => quantityFor(10_000, price(1), PRICE_FACTOR_ONE, "EUR", 0 as Quantity),
      (e) => isValidationError(e, "invalid_quantity_step"),
    );
    assert.throws(
      () => quantityFor(10_000_000_000, price(0.000001), PRICE_FACTOR_ONE, "EUR"),
      (e) => isValidationError(e, "invalid_quantity"),
    );
  });
});

describe("priceFrom", () => {
  it("divides an amount by a quantity, half to even at 6 decimals", () => {
    // €1,000 for 3 units: €333.333333(3).
    assert.equal(priceFrom(100_000, units(3), PRICE_FACTOR_ONE, "EUR"), 333_333_333);
    // €0.01 for 4,000 units is 0.0000025: half way, to the even 0.000002.
    assert.equal(priceFrom(1, units(4000), PRICE_FACTOR_ONE, "EUR"), 2);
    // €0.03 for 4,000 units is 0.0000075: half way, to the even 0.000008.
    assert.equal(priceFrom(3, units(4000), PRICE_FACTOR_ONE, "EUR"), 8);
    // €0.03 for 20,000 units is 0.0000015: half way, to the even 0.000002.
    assert.equal(priceFrom(3, units(20_000), PRICE_FACTOR_ONE, "EUR"), 2);
  });

  it("gives back the quoted price of a bond and of a JPY instrument", () => {
    assert.equal(priceFrom(987_654, units(10_000), PRICE_FACTOR_HUNDREDTH, "EUR"), 98_765_400);
    assert.equal(priceFrom(3704, units(3), PRICE_FACTOR_ONE, "JPY"), 1_234_666_667);
  });

  it("takes the sign of a negative amount over a negative quantity", () => {
    assert.equal(priceFrom(-100_000, units(-3), PRICE_FACTOR_ONE, "EUR"), 333_333_333);
  });

  it("rejects a quantity of zero and a negative result", () => {
    assert.throws(() => priceFrom(100, 0 as Quantity, PRICE_FACTOR_ONE, "EUR"), (e) => isValidationError(e, "invalid_quantity"));
    assert.throws(() => priceFrom(-100, units(1), PRICE_FACTOR_ONE, "EUR"), (e) => isValidationError(e, "invalid_price"));
  });
});

describe("proportionalCost", () => {
  it("splits €1,000 over three sales of one unit into 333.33, 333.34 and 333.33, adding up exactly", () => {
    let cost = 100_000;
    let held = units(3);
    const removed: number[] = [];
    for (let sale = 0; sale < 3; sale++) {
      const part = proportionalCost(cost, ONE_UNIT, held);
      removed.push(part);
      cost -= part;
      held = toQuantity(held - ONE_UNIT);
    }
    assert.deepEqual(removed, [33_333, 33_334, 33_333]);
    assert.equal(removed.reduce((a, b) => a + b, 0), 100_000);
    assert.equal(cost, 0);
  });

  it("rounds half away from zero", () => {
    assert.equal(proportionalCost(1, units(1), units(2)), 1);
    assert.equal(proportionalCost(-1, units(1), units(2)), -1);
    assert.equal(proportionalCost(3, units(1), units(4)), 1);
  });

  it("returns the whole cost when every unit is sold, and nothing when none is", () => {
    assert.equal(proportionalCost(33_333, units(0.12345678), units(0.12345678)), 33_333);
    assert.equal(proportionalCost(33_333, 0 as Quantity, units(3)), 0);
  });

  it("multiplies exactly when cost × sold goes beyond 2^53", () => {
    const held = units(90_000_000);
    const sold = units(30_000_000);
    assert.equal(proportionalCost(9_000_000_000_000_000, sold, held), 3_000_000_000_000_000);
  });

  it("rejects selling more than is held, a negative sale and an empty position", () => {
    for (const [sold, held] of [
      [units(2), units(1)],
      [units(-1), units(1)],
      [0, 0],
    ] as const) {
      assert.throws(
        () => proportionalCost(100, sold as Quantity, held as Quantity),
        (e) => isValidationError(e, "invalid_sale_quantity"),
        `${sold} of ${held}`,
      );
    }
  });
});

// The branded types are plain numbers at run time, so they serialize to JSON as they are.
describe("Quantity, Price and PriceFactor at run time", () => {
  it("are plain numbers", () => {
    const value: { quantityE8: Quantity; priceE6: Price; factor: PriceFactor } = {
      quantityE8: units(1.5),
      priceE6: price(87.123456),
      factor: PRICE_FACTOR_HUNDREDTH,
    };
    assert.equal(JSON.stringify(value), '{"quantityE8":150000000,"priceE6":87123456,"factor":10000}');
  });
});
