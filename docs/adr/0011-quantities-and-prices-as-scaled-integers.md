# 0011 — Quantities and prices as scaled integers

- **Status:** accepted
- **Date:** 2026-11-20

## Context

ADR 0002 makes every amount an integer number of the currency's minor unit, and leaves the quantities and prices of financial instruments to a separate decision. design.md ("Accounting rules") fixes their precision: 8 decimals for quantities, so fractional shares fit, and 6 for prices.

Quantity × price must become an amount in `Cents` exactly and reproducibly on the server, in the browser and on the phone: positions are derived values, recomputed from trades, so they must come out the same bit for bit wherever and whenever they are rebuilt. A product of two such numbers easily goes beyond 2^53, where JavaScript numbers stop being exact.

## Decision

- **Database.** Quantities and prices are `bigint` columns holding scaled integers, with the scale in the column name, the way `_cents` marks amounts: `quantity_e8` is the number of units × 10^8, `price_e6` the price of one unit in the instrument's currency × 10^6.
- **TypeScript.** `packages/core` defines the branded types `Quantity` and `Price`: safe-integer `number`s in the same scales. `assertQuantity` and `assertPrice` check them with `Number.isSafeInteger` (a price must also not be negative) and otherwise throw a `ValidationError` with a stable code (`invalid_quantity`, `invalid_price`). The safe range is about 90 million units and about 9 billion per unit; anything beyond is rejected, never rounded.
- **Arithmetic.** Products and quotients (quantity × price, cost × sold ÷ held, amount ÷ price) are computed only in `packages/core`, with `BigInt`, and converted back to checked `Cents` or `Quantity`. Nothing else multiplies or divides scaled values.
- **Edges.** The API and the sync protocol carry the same scaled integers, as `quantityE8` and `priceE6`. Text is converted only at the edges, like `parseAmount` and `formatMoney`: `parseQuantity` and `parsePrice` read what the user typed in their locale (an Italian decimal comma included), `formatQuantity` and `formatPrice` display it.
- **Price factor.** An instrument carries a price factor, stored the same way as `price_factor_e6` (× 10^6): 1 (`1000000`) for most instruments, 0.01 (`10000`) for bonds quoted in percent of nominal and for instruments quoted in hundredths of their currency (pence for a GBP instrument). The amount of a trade is quantity × price × price factor.
- **Rounding.** Each conversion has one rule:
  - quantity × price × price factor → `Cents`: half away from zero, to the currency's minor unit, rounded once at the end of the calculation. The amount stored on a trade may differ from it, to match what the broker actually charged.
  - amount → quantity: toward zero, to 8 decimals, or to whole units (or another step) when fractional units are not available, so an order never spends more than the money available.
  - amount ÷ quantity → price, and the average cost shown for a position: half to even, to 6 decimals. Display only: it is never stored nor used to compute anything else.
  - cost removed from a position on a sale = cost × sold ÷ held, half away from zero, to the minor unit; selling everything removes exactly the cost that is left, so the cost of a position always adds up.
- **Exchange rates (milestone 0.2.1).** A constraint for when they arrive: rates are stored with at least 10 significant digits, in one stated direction, and are never inverted.

## Discarded alternatives

- **`numeric(p,8)` and `numeric(p,6)` columns.** PostgreSQL silently rounds a value with too many decimals on insert, node-postgres returns `numeric` as strings that every caller would have to parse, and amounts would follow a different rule from ADR 0002's.
- **`bigint` in TypeScript everywhere.** Exact, but not serializable to JSON, and awkward in the sync protocol and in the UI. `BigInt` stays inside the core's calculations.
- **A decimal library.** Correct, but it adds a dependency to a core that has none (ADR 0003), and every operation becomes a function call anyway.

## Consequences

- Sums and comparisons of quantities and prices are exact, as they are for amounts.
- A position above about 90 million units, or a price above about 9 billion per unit, is rejected; if that is ever needed it will take a new ADR.
- Every boundary (forms, CSV import, the API, sync, the database) parses into the scaled form and never handles decimal fractions in floating point. Tests cover the round trips and the half-way case of every rounding rule.
