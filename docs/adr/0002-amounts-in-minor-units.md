# 0002 — Amounts as integer minor units

- **Status:** accepted
- **Date:** 2026-09-25

## Context

JavaScript numbers (like Perl's) are floating point: `0.1 + 0.2` is `0.30000000000000004`. In a personal finance app, a one-cent difference makes accounts impossible to reconcile.

## Decision

- Every amount is an integer number of the currency's minor unit, of type `Cents`: €12.34 is `1234`, ¥1,235 is `1235`.
- Every core function validates amounts with `assertCents`, which rejects fractions, `NaN` and numbers beyond the precision limit (about 90 trillion).
- Converting to and from text happens only at the edges: `parseAmount` reads what the user typed in their locale, `formatMoney` displays the amount. Both use the currency's number of decimals (2 for EUR, 0 for JPY, 3 for KWD).
- In the database, amounts will be integer columns (`bigint`).

## Discarded alternatives

- **Floating-point numbers:** rounding errors.
- **Decimal libraries** (for example decimal.js): correct but slower, and every operation becomes a function call. They may be considered for instrument prices, which have more than two decimals.

## Consequences

- Sums and comparisons are exact.
- Quantities and prices of financial instruments will have their own rule, with more decimals: it will be a separate ADR.
