# scripts

Development scripts. Git hooks and GitHub setup are plain bash (`git-hooks/`, `github/`); the
Keycloak realm bootstrap is bash too (`keycloak/bootstrap.sh`, see the root
[`docs/getting-started.md`](../docs/getting-started.md)). `@envelope/scripts` (this package) is
the one part with real dependencies — currently the demo data seed.

## Demo data seed

`seed-demo.ts` builds a realistic "Demo" workspace by driving the real `apps/api` over HTTP, the
same way `apps/web` itself does — not direct SQL. Workspace budgeting's correctness lives in a
few places only the real API exercises: the assignment ledger is append-only (ADR 0008), every
request goes through a workspace's Row-Level Security policy, and `@envelope/core`'s own
invariant only holds if the data was built the way the real app builds it. Two narrow exceptions,
both isolated in `lib/db.ts`: there is no HTTP endpoint yet to create or delete a workspace and its
first membership, and no way to ask `POST .../accounts` to date a credit card's own "Starting
balance" transaction as anything but `now()` (`#326`) — everything else (accounts, categories,
transactions, splits, transfers, assignments, scheduled transactions, goals) is a real API call.

Getting a real access token without a browser is the other wrinkle: the `envelope-api` Keycloak
client is public, PKCE-only, with no password grant (by design). `lib/keycloak.ts` drives the
real Authorization Code + PKCE handshake with plain `fetch` against Keycloak's own server-rendered
login form instead — an ordinary HTML form post, no headless browser needed for this part.

The data recalls `docs/ux/mockups/budget-month.html` and `account-register.html` (category
groups, two credit cards with starting debt, scheduled transactions, targets of several kinds),
translated into English rather than the mockups' own Italian sample data (everything committed
to the repository is English-only, `CLAUDE.md`). It covers one instance of every state those
mockups draw: a category overspent in cash, a category overspent on a card, a reservation a
category cannot cover (a warning, not overspending), one card's payment category fully covered
and the other's still short, a target still missing money, an overdue scheduled transaction not
yet recorded, and a pending transaction. Every date is relative to the day the script runs (this
calendar month, with scheduled transactions both before and after today), never hard-coded.
The previous month also gets a full, spread-out month of ordinary transactions of its own (salary,
mortgage, utilities, groceries, a card purchase — `#326`): unlike the current month's, whose
recorded transactions are clamped to on-or-before today (`onOrBeforeToday`, so they never land on
a day that has not happened yet), every day of the previous month is already in the past, so
nothing needs clamping — a real spread across the whole month for the budget month's own timeline
to actually draw, rather than a cluster of marks on today's own day alone. A second income
transaction that same month (on top of its own salary) keeps "Unassigned" plausible looking back
at it too: `computeBudgetMonth`'s own rule counts *every* assignment ever made, current and future
months included, against only the income recorded by the month being viewed, so the previous
month's own income has to cover the current and next months' pre-funding as well, not just its own
spending. Each credit card's own "Starting balance" transaction (`POST .../accounts`, dated
`now()` with no way to ask for another date) is moved to the previous month's own first day with
one small, isolated direct-SQL update (`lib/db.ts`'s own `backdateStartingBalance`) right after
creating it — otherwise a card seeded as part of a month that is supposed to be already over would
read as if its debt arrived today, in the middle of the current month's own story instead.
After seeding, it verifies `@envelope/core`'s own invariant (unassigned money + every category's
available + reserved + assigned to future months + credit overspending = the on-budget cash
accounts' own balance, cards excluded) the same way `apps/web` itself could: from the budget
month endpoint and each cash account's own transaction list, never a direct query. A broken
invariant fails the script loudly.

Checking has no "starting balance" field of its own the way a credit card does (`POST
.../accounts`'s own `startingBalanceCents` is ignored for anything but an on-budget credit card)
— so its own opening balance is an ordinary income-shaped transaction instead, dated and recorded
before every other movement on day 1 of the previous month. Sized (`€2,000.00`) so the account's
own running balance never dips below zero across the whole demo: day 12 of the previous month is
its deepest point, before that month's own salary arrives on the 15th (`#351`; it used to start at
zero and run briefly negative there).

### Running locally

Needs, already running: PostgreSQL and Keycloak (`cd infra && docker compose up -d`, with the
`envelope` realm bootstrapped, `docs/getting-started.md`), and `apps/api` with a real `.env`
(`apps/api/README.md`).

```bash
$ cd scripts
$ cp .env.example .env   # fill in DATABASE_URL, KEYCLOAK_ADMIN_PASSWORD, DEMO_USER_PASSWORD
$ pnpm seed:demo
```

Refuses to run if `NODE_ENV=production`, or if `API_URL`, `DATABASE_URL` or `KEYCLOAK_URL` does
not resolve to `127.0.0.1`/`localhost` (the error names which one) — this creates and deletes a
whole workspace, reads and writes the database directly, and talks to Keycloak's own admin API,
never something to risk against a real deployment. A "Demo" workspace already existing makes it
exit immediately with a message; pass `--reset` to delete the previous one first and seed fresh:

```bash
$ pnpm seed:demo -- --reset
```

The persistent "demo" Keycloak user (not a throwaway one, unlike the end-to-end tests' own) is
created on first run and left alone afterward; sign in as it with the password in
`DEMO_USER_PASSWORD` to look around.

### Reference screenshots

`screenshot-demo.ts` regenerates the reference screenshots from the already-seeded "Demo"
workspace: light and dark, at 1440px, 390px and 360px, for the budget month (this month and the
previous one, `#326` — the previous month's own full spread of transactions, above, is what makes
its timeline worth looking at), the accounts list and the account register, named after
`docs/ux/screenshots/budget-month-*.png`/`account-register.png`'s existing convention (with a size
suffix, since those were only ever one size). Needs `apps/web` running too (not just `apps/api`),
since unlike the seed script's own plain-`fetch` handshake, this drives the real sign-in form
through a real (headless) browser to actually render pixels.

At 390px and 360px it also asserts there is no horizontal overflow
(`document.documentElement.scrollWidth <= clientWidth`, `#333`'s own acceptance criterion, extended
to the budget month by `#326`) on every screen, failing the script (non-zero exit) if any does —
the same check a reviewer would otherwise have to do by hand with the browser's own dev tools. A
screen whose phone layout is a genuinely different DOM tree (not just a CSS reflow), like the
account register's day list, swaps it in from a `resize` event listener one tick behind
`setViewportSize` itself, so the check waits briefly after resizing the page before measuring it.
It also asserts the account register's own phone list keeps its payee text at a WCAG-contrast
>= 4.5:1 against the page background, in both themes (`#349`: a class name shared by
unrelated components — the band's own `.who` and this list's own — once left it reading the band's
muted colour by accident).

```bash
$ cd scripts
$ pnpm screenshots:demo
```

Saved **outside** the repository, in `~/screenshots/` — not committed, for manual review (`#323`'s
own real-app screenshots followed the same rule). Replacing the committed
`docs/ux/screenshots/*.png` (currently rendered from the mockups) with these is a separate,
deliberate step once bars/timeline/phone layout actually exist (`#324`, `#326`, `#331`, `#333`,
`#337`), not something this command does on its own.

## Contents

| File | What it does |
| --- | --- |
| `seed-demo.ts` | The demo data seed (above) |
| `screenshot-demo.ts` | Regenerates the reference screenshots from the seeded "Demo" workspace (above) |
| `lib/env.ts` | `requireEnv`: fails fast on a missing variable; `assertSafeToRun`: refuses `NODE_ENV=production` or any given URL that is not local, naming which one (`lib/env.test.ts`) |
| `lib/keycloak.ts` | `ensureDemoUser`/`signInAsDemoUser`: the persistent demo user and the browser-free PKCE handshake; `subjectOf`: an access token's own `sub` claim |
| `lib/api.ts` | `Api`: a thin authenticated `fetch` wrapper against `apps/api` — no generated client exists yet |
| `lib/db.ts` | The two steps done with direct SQL: creating/deleting the "Demo" workspace and its first membership, and backdating a credit card's own "Starting balance" transaction (see above) |
| `lib/dates.ts` | `todayAt(now, timeZone)`: every date the seed uses, relative to an injected "today" (never read from the clock directly, so it is testable — `lib/dates.test.ts`). The rule it encodes: a *recorded* transaction's date is never after today (`onOrBeforeToday` clamps a fixed day down to today); a scheduled transaction can genuinely be due before or after today (`beforeTodaySameMonth`/`afterTodaySameMonth`, each falling back to the adjacent month at the rare edge — today being the 1st or the month's last day) |
