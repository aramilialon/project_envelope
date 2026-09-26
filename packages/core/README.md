# @envelope/core

The domain logic of envelope: the budget rules, and later portfolios and rebalancing. It contains only **pure** functions: they take data and return results, and never touch a database, the network or files. That is why they run the same on the server, in the browser and on the phone, and why they are tested in milliseconds.

## Contents

| File | What it does |
| --- | --- |
| `src/errors.ts` | `ValidationError` with a stable `code` that the UI translates |
| `src/money.ts` | Amounts as integer minor units: validation, sums, locale-aware parsing and formatting |
| `src/month.ts` | "YYYY-MM" months and "YYYY-MM-DD" dates: validation, month of a date, next month, comparison, ranges |
| `src/budget/transactions.ts` | From individual transactions to monthly totals: income, splits, transfers, card payments, off-budget accounts |
| `src/budget/budget-month.ts` | One budget month: unassigned money, rollover, cash and credit overspending, credit card payment categories |
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
- Transfers between two credit cards (balance transfers) are rejected for now.
- Uncategorized transactions are rejected: the import flow stages rows until every one has a category, is a transfer, or is income (design.md, "Import and reconciliation").
