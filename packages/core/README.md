# @envelope/core

The domain logic of envelope: the budget rules, and later portfolios and rebalancing. It contains only **pure** functions: they take data and return results, and never touch a database, the network or files. That is why they run the same on the server, in the browser and on the phone, and why they are tested in milliseconds.

## Contents

| File | What it does |
| --- | --- |
| `src/errors.ts` | `ValidationError` with a stable `code` that the UI translates |
| `src/money.ts` | Amounts as integer minor units: validation, sums, locale-aware parsing and formatting |
| `src/month.ts` | "YYYY-MM" months and "YYYY-MM-DD" dates: validation, month of a date, next/previous month, comparison, ranges, days between two dates; `advanceDate` moves a date forward by a scheduled transaction's own recurrence step (day/month/year), calendar-aware — adding a month to "2026-01-31" lands on the last day of February, never rolling into March |
| `src/budget/transactions.ts` | From individual transactions to monthly totals: income, splits, transfers, card payments, card-to-card transfers, off-budget accounts |
| `src/budget/budget-month.ts` | One budget month: unassigned money, rollover, cash and credit overspending, credit card payment categories, a transfer between two cards' payment categories capped at what the source holds (never cash overspending), scheduled transactions not yet recorded reserving money in their category (`available` net of it, never counted as overspending) |
| `src/budget/targets.ts` | The four target kinds (monthly amount, amount by a date, repeating expense, balance to keep): what each asks this month, what is missing, progress |
| `src/budget/days-of-buffer.ts` | Amount-weighted average days between a euro coming in and being spent, first in first out, over the outflows of the last 30 days |
| `src/import/duplicate-detection.ts` | Matches an import's rows against an account's existing transactions: the bank's own transaction id, or otherwise the same amount within a 3-day window; each existing transaction matches at most one row |
| `src/import/row.ts` | `ImportRow`, the normalized shape every import source (CSV, OFX, QIF, CAMT.053) produces before duplicate detection |
| `src/import/csv.ts` | Parses a mapped CSV file's rows: one amount column or separate outflow/inflow columns, three date formats, either decimal separator, an optional header row and memo column |
| `src/import/ofx.ts` | Parses an OFX statement download's `<STMTTRN>` transactions, no mapping needed; reads both OFX 1.x's unclosed SGML tags and OFX 2.x's closed XML tags the same way |
| `src/import/qif.ts` | Parses a QIF file's `D`/`P`/`M`/`T` transaction fields, no column mapping; its date order and decimal separator, unlike OFX's, are not standardized across sources — both are inferred from the file's own data, or an explicit hint, before parsing a single transaction |
| `src/import/camt053.ts` | Parses an ISO 20022 CAMT.053 statement's `<Ntry>` entries, no mapping and no date/decimal ambiguity (ISO 20022 fixes both); the counterparty name and remittance info come from the entry's first transaction detail, when the bank includes one |
| `src/sync/hlc.ts` | Hybrid logical clock (design.md, "Field-level change protocol"): `nextHlc` ticks a device's own clock forward even if its wall clock disagrees with or runs behind a previous value; `compareHlc` gives every two changes a total, deterministic order for "last write wins" |
| `src/presentation/bars.ts` | A category's bar geometry for the budget month (design.md, "Bars"; `#324`): track/spent/reserved percentages, the tail beyond the track (cash/credit overspending, or a reservation beyond what is left) and its kind, a payment category's covered/uncovered debt split — plain percentages and an enum out, never HTML or text |
| `src/presentation/timeline.ts` | The month's own day-by-day timeline (design.md, "Timeline"; `#326`): lays out a list of events into plain coordinates, a mark's length growing with the square root of its amount, a day with several events capped to its own first two payees plus a count, and label placement that never crosses the "today" line or the canvas's own edge — tried on the stem's own other side first, left out entirely rather than overlapping either one. `formatAmount`/`formatPayees`, both optional callbacks a caller injects, only ever feed the label-width *estimate* — the composed text itself stays the caller's own (no user-facing text here) — reused as-is by the account register's own timeline (`#337`) |
| `src/presentation/todos.ts` | The budget month's own "To do" list (design.md, "To do"; `#326`): a typed list of what needs attention this month (overspending, overdue scheduled transactions, a reservation shortfall, uncovered card debt, targets still missing money), in priority order — never literal text. `amountNeededToCover` (`#328`) is the same priority, as a single figure: what "Move money" preselects when opened from a category's own row. `reservationShortfall` (`#217`) is the reservation-only figure behind it, also used directly by the budget month's own row status line |
| `src/index.ts` | What the package exposes to the apps |
| `*.test.ts` | Tests, next to the file they check |

## Commands

```bash
pnpm --filter @envelope/core test        # run the tests
pnpm --filter @envelope/core typecheck   # check types with TypeScript
```

## Things to understand

Comparisons with Perl, to find your way around the code.

| In this code | In Perl | Note |
| --- | --- | --- |
| `import { x } from "./money.ts"` | `use Money qw(x);` | Every file is a module and exports only what is marked `export` |
| `const total = 0` / `let total = 0` | `my $total = 0;` | `const` cannot be reassigned, `let` can. Prefer `const` wherever possible |
| `interface Income { month: Month; amount: Cents }` | a hashref `{ month => ..., amount => ... }` | Describes the shape of the data; TypeScript reports a missing or mistyped field before the code even runs |
| `new Map<string, Cents>()` | `my %h;` | A hash with typed keys and values |
| `map.get(k) ?? 0` | `$h{$k} // 0` | Fallback value when the key does not exist |
| `(id) => [id, 0]` | `sub { my ($id) = @_; [$id, 0] }` | Anonymous function ("arrow function") |
| `` `month ${m}` `` | `"month $m"` | String interpolation, with backticks |
| `throw new ValidationError(...)` | `die ...` | Raises an error; the caller can catch it with `try/catch` (like `eval {}`) |
| `describe` / `it` / `assert.equal` | `Test::More`: `subtest` / `is` | Tests use `node:test`, built into Node.js |
| `readonly` | — | The field cannot change after creation: protects data from accidental changes |

### Four ideas to take away

1. **Amounts as integer minor units.** `0.1 + 0.2` in JavaScript is `0.30000000000000004`, just like in Perl. With cents (`10 + 20 = 30`) the problem does not exist.
2. **Pure functions.** `computeBudgetMonth` does not know where its data comes from. The server will read it from PostgreSQL, the phone from SQLite; the rule stays in one place.
3. **Invariant tests.** Besides examples, two tests generate hundreds of random budgets and transaction histories and check that the books always balance: unassigned money + available (payment categories included) + assigned in future + this month's credit overspending = balance of the on-budget cash accounts. They are the safety net for future changes.
4. **No user-facing text.** The core returns data and error codes, never sentences. Words and number formats belong to the UI and depend on the user's language (see [ADR 0004](../../docs/adr/0004-internationalization.md)).

## Current limitations

- Income on a credit card (for example cashback) is not modeled as a transaction here yet; the API composes it from an income transaction plus a card payment instead (design.md, "Credit cards").
- Uncategorized transactions are rejected: the import flow stages rows until every one has a category, is a transfer, or is income (design.md, "Import and reconciliation").
