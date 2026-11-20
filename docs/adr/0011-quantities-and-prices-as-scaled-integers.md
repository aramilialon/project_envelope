# 0011 — Quantities and prices as scaled integers

- **Status:** accepted
- **Date:** 2026-11-20

## Context

ADR 0002 makes every amount an integer number of the currency's minor unit, and leaves the quantities and prices of financial instruments to a separate decision. design.md ("Accounting rules") fixes their precision: 8 decimals for quantities, so fractional shares fit, and 6 for prices.

Quantity × price must become an amount in `Cents` exactly and reproducibly on the server, in the browser and on the phone. Positions are derived values (design.md, "Positions"): they are rebuilt by replaying the trades, so they must come out the same bit for bit wherever and whenever that happens. A product of two such numbers easily goes beyond 2^53, where JavaScript numbers stop being exact.

## Decision

- **Database.** Quantities and prices are `bigint` columns holding scaled integers, with the scale in the column name, the way `_cents` marks amounts:
  - `quantity_e8` is the number of units × 10^8. For a bond quoted in percent, the quantity is its nominal amount in the instrument's currency: 10 bonds of €1,000 nominal are a quantity of 10,000, not 10.
  - `price_e6` is the price as quoted for one unit × 10^6. It is in the instrument's currency when the price factor is 1; otherwise the amount per unit is price × price factor (a bond quoted in percent, a share quoted in pence).
- **TypeScript.** `packages/core` defines the branded types `Quantity` and `Price`: safe-integer `number`s in the same scales. `assertQuantity` and `assertPrice` check them with `Number.isSafeInteger` (a price must also not be negative) and otherwise throw a `ValidationError` with a stable code (`invalid_quantity`, `invalid_price`). The safe range is about 90 million units and about 9 billion per unit; anything beyond is rejected, never rounded.
- **Arithmetic.** Products and quotients (quantity × price, cost × sold ÷ held, amount ÷ price) are computed only in `packages/core`, with `BigInt`, and converted back to checked `Cents` or `Quantity`. Nothing else multiplies or divides scaled values.
- **Price factor.** An instrument carries a price factor, stored the same way as `price_factor_e6` (× 10^6): 1 (`1000000`) for most instruments, 0.01 (`10000`) for bonds quoted in percent of nominal and for instruments quoted in hundredths of their currency (pence for a GBP instrument). The amount of a trade is quantity × price × price factor.
- **Edges.** The API and the sync protocol carry the same scaled integers, as `quantityE8`, `priceE6` and `priceFactorE6`. Text is converted only at the edges, like `parseAmount` and `formatMoney`: `parseQuantity` and `parsePrice` read what the user typed in their locale (an Italian decimal comma included), `formatQuantity` and `formatPrice` display it. A price is shown with its currency only when the price factor is 1.
- **Rounding.** Each conversion has one rule:
  - quantity × price × price factor → `Cents`: half away from zero, to the currency's minor unit, rounded once at the end of the calculation. The amount stored on a trade may differ from it, to match what the broker actually charged.
  - amount → quantity: toward zero, to 8 decimals, or to whole units (or another step) when fractional units are not available, so the amount of the resulting quantity never exceeds the money available. The amount passed in must already be net of fees, and a broker that rounds its own charge up can still charge one minor unit more.
  - amount ÷ quantity → price, and the average cost shown for a position: half to even, to 6 decimals. Display only: it is never used to compute anything else. The one exception is an imported trade that comes with an amount and a quantity but no price: the price derived from them may be stored as the trade's quoted price.
  - cost removed from a position on a sale = cost × sold ÷ held, half away from zero, to the minor unit; selling everything removes exactly the cost that is left, so the cost of a position always adds up.
- **Positions.** The cost method is the weighted average cost, per account and instrument. Positions are rebuilt by replaying the trades in one fixed order, `(occurred_at, created_at, id)`. The order matters because the cost removed by each sale is rounded: with a cost of 101 cents on 4 units, selling 1 and then 1 removes 25 + 25 = 50 cents, selling 2 at once removes 51. A fixed order makes every rebuild give the same result.
- **Values.** A position's value is `amountOf(total quantity, price, price factor)`, rounded once per position, never as a sum of rounded lots. Net worth is the sum of the position values.
- **Exchange rates (milestone 0.2.1).** A constraint for when they arrive: rates are stored with at least 10 significant digits, in one stated direction, and are never inverted.

## Scope

- About 90 million units per position. That is enough for household use, but a bond's quantity is its nominal amount, so a bond in a currency with a very low value per unit can reach it.
- Crypto-like tokens, which need more than 8 decimals or far larger quantities, are out of scope.
- Instruments whose amount is not quantity × price × a constant factor (inflation-linked bonds, for example) are out of scope.
- Accrued interest on a bond is not part of its price: it is a separate field of the trade.

## Discarded alternatives

- **`numeric(p,8)` and `numeric(p,6)` columns.** PostgreSQL silently rounds a value with too many decimals on insert, node-postgres returns `numeric` as strings that every caller would have to parse, and amounts would follow a different rule from ADR 0002's.
- **`bigint` in TypeScript everywhere.** Exact, but not serializable to JSON, and awkward in the sync protocol and in the UI. `BigInt` stays inside the core's calculations.
- **A decimal library.** Correct, but it adds a dependency to a core that has none (ADR 0003), and every operation becomes a function call anyway.

## Consequences

- Sums and comparisons of quantities and prices are exact, as they are for amounts.
- A position above about 90 million units, or a price above about 9 billion per unit, is rejected; if that is ever needed it will take a new ADR.
- Every boundary (forms, CSV import, the API, sync, the database) parses into the scaled form and never handles decimal fractions in floating point. Tests cover the round trips and the half-way case of every rounding rule.
- Rebuilding positions needs the trades' fixed replay order; two trades with the same time are still ordered by when they were created and by id.
