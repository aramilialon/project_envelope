# @envelope/core

The domain logic of envelope: the budget rules, and later portfolios and rebalancing. It contains only **pure** functions: they take data and return results, and never touch a database, the network or files. That is why they run the same on the server, in the browser and on the phone, and why they are tested in milliseconds.

## Contents

| File | What it does |
| --- | --- |
| `src/errors.ts` | `ValidationError` with a stable `code` that the UI translates |
| `src/money.ts` | Amounts as integer minor units: validation, sums, locale-aware parsing and formatting |
| `src/month.ts` | "YYYY-MM" months: validation, next month, comparison, ranges |
| `src/budget/budget-month.ts` | One budget month: ready to assign, rollover of available balances, overspending |
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
3. **Invariant tests.** Besides examples, one test generates 500 random budgets and checks that the books always balance: ready to assign + available + assigned in future = account balance. It is the safety net for future changes.
4. **No user-facing text.** The core returns data and error codes, never sentences. Words and number formats belong to the UI and depend on the user's language (see [ADR 0004](../../docs/adr/0004-internationalization.md)).

## Current limitations

- All spending is treated as cash or debit. Credit cards will come with their payment category.
- Amounts arrive already grouped by category and month: grouping individual transactions is the next step.
