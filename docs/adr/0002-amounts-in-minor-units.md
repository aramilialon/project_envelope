# 0002 — Amounts as integer minor units

- **Status:** accepted
- **Date:** 2026-09-25
- **Amended:** 2026-11-21 (#651): a cap on a single amount

## Context

JavaScript numbers (like Perl's) are floating point: `0.1 + 0.2` is `0.30000000000000004`. In a personal finance app, a one-cent difference makes accounts impossible to reconcile.

## Decision

- Every amount is an integer number of the currency's minor unit, of type `Cents`: €12.34 is `1234`, ¥1,235 is `1235`.
- Every core function validates amounts with `assertCents`, which rejects fractions, `NaN` and numbers beyond the precision limit (about 90 trillion).
- Converting to and from text happens only at the edges: `parseAmount` reads what the user typed in their locale, `formatMoney` displays the amount. Both use the currency's number of decimals (2 for EUR, 0 for JPY, 3 for KWD).
- In the database, amounts will be integer columns (`bigint`).

### Amendment (#651): a cap on a single amount

`assertCents` alone allowed any single amount up to about 90 trillion. Two such amounts (or the largest one plus one cent) added up beyond the safe integer range, and from then on every budget month of the workspace was unreadable.

- **The cap.** A single amount is at most `MAX_AMOUNT_CENTS` = 10^11 minor units either way: €1,000,000,000.00. `assertAmount` checks it, after `assertCents`, and refuses anything beyond with `ValidationError("amount_too_large")`, whose `details` carry `label` (which amount), `max` (the cap) and `value`. The API answers it with 400.
- **Where it applies.** To every amount being written: `parseAmount` (what the user types), the import parsers (each row of a file), and in the API every write path — a transaction's splits and its own total, transfers and transfer legs, assignments, a card's starting balance, scheduled transactions, targets, a reconciliation's adjustment, and a trade's gross, fees, taxes, cost basis and cash leg (`checkTradeEntry`). Sums, balances and computed figures are not capped: they keep `assertCents`, so a budget whose total is above €1,000,000,000 still works.
- **Balances typed by the user are not capped.** A reconciliation's statement balance and an import's closing balance are only compared with the account's balance, never written as an amount or added up, so they keep `assertCents` (the web forms read them with `parseBalance`, which is `parseAmount` without the cap). An account may lawfully hold more than the cap. What such a comparison would write is capped: a reconciliation's adjustment, the difference between the two balances, is refused with `amount_too_large` labelled `adjustment`.
- **Totals.** Every figure of a budget month is a sum of some of its inputs, so `aggregateTransactions` and `computeBudgetMonth` check that the sum of the inputs' sizes is a safe integer. With every amount capped, that needs about 90,000 amounts at the cap. If it is not, they throw `ValidationError("amount_total_overflow")` naming what to look at (`aggregateTransactions`: the transactions above the cap, or the largest ones, in `details.transactionIds`, comma-separated and at most 20, with `details.count` the full total; `computeBudgetMonth`: the input that tipped it, by `label`, `month` and `categoryId`); `sumCents` and `assertTotal` throw it too, and so does `computePositions` when a running total of a position (its cost, or one of its totals) leaves the safe range, naming the trade being replayed in `details.tradeId`. The API answers it with 422: the stored rows, not the request, are the problem. `Cents` stays a `number`: no `BigInt` (below).
- **The cap is in minor units, whatever the currency.** For a currency with two decimals it is 1,000,000,000.00; with none (JPY) ¥100,000,000,000, about €600 million at the time of writing; with three (KWD) 100,000,000.000 dinars, about €300 million. Where the minor unit is worth least the cap is lowest in value: for the Uzbek som (two decimals) it is 1,000,000,000.00 som, about €65,000–70,000, and for the Iranian rial (no decimals, as the app formats it) 100,000,000,000 rials, about €100,000 at the market rate at the time of writing. Even those are above what a household moves in one transaction, but not by much; a workspace in such a currency that needs more is a reason to revisit the value of `MAX_AMOUNT_CENTS`, which is one constant. The others are far above what a household or a family budget moves in one transaction, and the safety margin the cap buys is the same in every currency, since it is a count of minor units. A per-currency cap was not chosen: it would tie a rule of exact arithmetic to exchange rates that move.
- **Rows stored before the cap.** No migration refuses or rewrites them, and no database constraint is added: an existing row above the cap still reads, and only a sum that leaves the safe range fails, with `amount_total_overflow`. `scripts/dev/find-amounts-over-cap.sql` is a read-only query that lists them (`apps/api/README.md`, "Amounts above the cap stored before #651").
- **Edits that re-check the whole row.** Some write paths check every amount of the row they write, not only the fields the request changes: editing a trade checks the whole trade as it would be after the edit (`checkTradeEntry`). Such an edit of a row stored above the cap before #651 — for example a memo-only edit of such a trade — is refused with `amount_too_large` until the amount itself is brought under the cap.
- **Not covered yet: valuation.** The value of a position is its quantity × a price (`amountOf`, ADR 0011), and prices are not stored yet. The work that stores prices must either cap a stored price so that every value it gives stays far inside the safe range, or answer `amount_total_overflow` naming the price row when a value leaves it.

## Discarded alternatives

- **Floating-point numbers:** rounding errors.
- **Decimal libraries** (for example decimal.js): correct but slower, and every operation becomes a function call. They may be considered for instrument prices, which have more than two decimals.
- **`BigInt` for `Cents`** (#651): it never overflows, but it cannot be mixed with `number` (every sum, comparison and `Intl` call changes), it is not valid JSON, and it is slower. A cap on a single amount keeps every realistic sum exact with plain numbers.
- **A `CHECK` constraint on every amount column** (#651): added `NOT VALID` it would leave old rows alone, but it would also refuse an unrelated edit of such a row (its memo, its status) with a database error. The cap is a rule of the domain, checked where the other amount rules are.

## Consequences

- Sums and comparisons are exact.
- No single amount can be above €1,000,000,000.00 (10^11 minor units, #651), and the budget stays readable however the amounts are combined.
- Quantities and prices of financial instruments have their own rule, with more decimals: scaled integers ([ADR 0011](0011-quantities-and-prices-as-scaled-integers.md)).
