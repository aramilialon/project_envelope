# scripts

Development scripts. Git hooks and GitHub setup are plain bash (`git-hooks/`, `github/`); the
Keycloak realm bootstrap (`keycloak/bootstrap.sh`) and the Postgres role password reset
(`dev/reset-role-passwords.sh`, see the root [`docs/getting-started.md`](../docs/getting-started.md),
section 9) are bash too. `@envelope/scripts` (this package) is the one part with real
dependencies — the demo data seed and the disposable environments.

## Demo data seed

`seed-demo.ts` builds a realistic "Demo" workspace by driving the real `apps/api` over HTTP, the
same way `apps/web` itself does — not direct SQL. Workspace budgeting's correctness lives in a
few places only the real API exercises: the assignment ledger is append-only (ADR 0008), every
request goes through a workspace's Row-Level Security policy, and `@envelope/core`'s own
invariant only holds if the data was built the way the real app builds it. One narrow exception,
isolated in `lib/db.ts`: no way to ask `POST .../accounts` to date a credit card's own "Starting
balance" transaction as anything but `now()` (`#326`) — everything else, including creating and
deleting the workspace itself (accounts, categories, transactions, splits, transfers, assignments,
scheduled transactions, goals), is a real API call.

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
its timeline worth looking at), the accounts list and the account register (plus the accounts
panel, `#412`, open over that register — light and dark at 1440px only, since it has no phone
layout), named after
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

## Disposable environments

`explore-env/` brings up a throwaway, isolated copy of the whole app for exploratory runs and for
the end-to-end tests (`#536`): its own database, its own Keycloak realm with persona users, its
own `apps/api` process and its own built `apps/web`, on free `127.0.0.1` ports, on the same
PostgreSQL and Keycloak servers as everything else. Several can run at the same time, next to a
developer's own `envelope` database, realm, API and dev server, without touching any of them.

```bash
$ cd scripts
$ pnpm explore:up                        # or: pnpm explore:up --root <dir>
$ pnpm explore:down <run>                # or: pnpm explore:down <dir>/<run>/manifest.json
$ pnpm explore:sweep                     # leftovers older than 24 h; --older-than-hours <n>
```

Needs `DATABASE_URL` (the superuser connection) and `KEYCLOAK_ADMIN_PASSWORD` in `scripts/.env`
or the environment, the same two the demo seed uses; `KEYCLOAK_URL` defaults to
`http://127.0.0.1:8080`. Refuses to run with `NODE_ENV=production`, with a `DATABASE_URL` or
`KEYCLOAK_URL` that is not local, or with a `KEYCLOAK_ISSUER` in the environment naming a realm
that is not a disposable one.

`up` picks a run id (8 random hex digits) and, in order:

1. creates the database `envelope_explore_<run>` (its creation time in the database's comment)
   and migrates it with `apps/api`'s own runner;
2. makes sure `envelope_app` and `envelope_queue` can log in to it, with the passwords
   `APP_DATABASE_URL`/`QUEUE_DATABASE_URL` give them (environment, then `apps/api/.env`, then the
   tests' fixed values). These roles are shared by every database on the server, so an existing
   password is never changed: only a role with no password at all (a fresh server, CI) gets one;
   a mismatch stops `up` and names the variable to set;
3. starts a small static file server (`explore-env/static-server.ts`) for the web app, so its
   origin is known before anything else needs it;
4. creates the realm `envelope-explore-<run>` (its creation time in a realm attribute), runs
   `keycloak/bootstrap.sh` on it with `KEYCLOAK_REALM` and `WEB_ORIGINS` set to that origin
   (the same public, PKCE-only `envelope-api` client as the shared realm, allowing only this
   origin), and adds a second public client, `envelope-explore-cli`, with the password grant and
   the API's audience, so a persona can get a token without a browser. Access tokens live 15
   minutes;
5. starts `apps/api` with an environment built from scratch, never inherited: the run's issuer,
   `WEB_ORIGIN` set to the web server's origin, `envelope_app`/`envelope_queue` connections to the
   run's database, the `postgres` queue driver and a fresh VAPID key pair;
6. builds `apps/web` (`vite build`) with `VITE_API_URL`, `VITE_KEYCLOAK_ISSUER` and
   `VITE_KEYCLOAK_CLIENT_ID` matching, into the directory the web server serves;
7. creates the personas: `household`, `investor` and `mixed`, each the owner of a workspace of
   its own (`Household`; `Investor` and `Mixed household`, whose tax country is `IT`), plus
   `<persona>-editor` and `<persona>-reader` with the `editor` and `read_only` roles in that
   workspace. Workspaces are created through `POST /workspaces` (and the tax country through
   `PATCH /workspaces/:workspaceId`) with each owner's own token. Adding the editor and reader is
   the one step done with direct SQL: no API adds a member to a workspace yet;
8. writes `manifest.json` in the run directory (`<root>/<run>`, by default
   `$TMPDIR/envelope-explore/<run>`).

The workspaces start empty: no seed data is loaded (`seed-demo.ts` targets the shared realm).
Before the 7th step, a first manifest without personas is written, so `down` can still find the
processes if something fails after it; on any failure `up` removes what it created itself.

Every API and web server process carries `envelope-explore-<run>` on its command line;
`down` checks it before signalling a PID (a PID the system reused since is left alone), and also
stops any process of the run the manifest does not list.

### The manifest

`<root>/<run>/manifest.json` (mode `0600`, in a directory of mode `0700`):

| Field | Contents |
| --- | --- |
| `run`, `createdAt`, `runDir` | The run id, when it was brought up, and where its files are |
| `database` | The database name (no connection string) |
| `web.url`, `api.url` | Where the web app and the API listen; open the web app on exactly this URL |
| `keycloak` | `url`, `realm`, `issuer`, `webClientId` (the web app's PKCE client), `apiClientId` (the password-grant client) and `tokenEndpoint` |
| `workspaces[]` | `persona`, `id`, `name` and `taxCountry` of each workspace |
| `users[]` | `persona`, `username`, `password`, `role` and `workspaceId` of each user |
| `processes` | The PIDs `down` stops (`api`, `web`) |
| `logs` | The API's, the web server's and the build's log files, in the run directory |

It never holds a superuser connection string, a database role's password or a Keycloak admin
credential: those stay in the `up`/`down` process and, for the role passwords, in the API
process's environment. Nothing secret is printed on stdout. A persona's token for calling the
API directly:

```bash
$ curl -s "$TOKEN_ENDPOINT" -d grant_type=password -d client_id=envelope-explore-cli \
    -d username=investor --data-urlencode "password=$PASSWORD" | jq -r .access_token
```

### Safety

`explore-env/names.ts` (tested in `explore-env/names.test.ts`) is the only place names are made
or checked: a database or realm name is built from a validated run id, or, when read from a
manifest or the server's own list, must be exactly `envelope_explore_<run>` or
`envelope-explore-<run>`. `envelope`, `keycloak`, `master`, `postgres`, `template0` and
`template1` are refused by name as well. Before the API starts and before the web app is built,
their environment is checked to name only this run's realm and database.

### Down and sweep

`down` takes a run id, a realm or database name, or a manifest path. It stops the processes,
drops the database `WITH (FORCE)`, deletes the realm and removes the run directory; anything
already gone is reported as such, so running it twice is safe.

`sweep` takes down every run under the root whose manifest is older than the threshold, then
every `envelope_explore_*` database and `envelope-explore-*` realm whose recorded creation time is
older (with its processes, found by their command line), whether or not a manifest is left. A
database or realm with no creation time recorded is reported and left alone.

### Memory

On the 6 vCPU, 16 GiB development host, one environment's own processes took about 135 MB
(API) and 75 MB (web server) of resident memory. The shared containers grew too: with three
environments up at once, Keycloak used about 715 MiB of the 1 GiB its container may use there (620 MiB with one) and
PostgreSQL about 195 MiB. Keycloak's memory is the limit to watch when running several.

## Contents

| File | What it does |
| --- | --- |
| `seed-demo.ts` | The demo data seed (above) |
| `screenshot-demo.ts` | Regenerates the reference screenshots from the seeded "Demo" workspace (above) |
| `lib/env.ts` | `requireEnv`: fails fast on a missing variable; `assertSafeToRun`: refuses `NODE_ENV=production` or any given URL that is not local, naming which one (`lib/env.test.ts`) |
| `lib/keycloak.ts` | `ensureDemoUser`/`signInAsDemoUser`: the persistent demo user and the browser-free PKCE handshake |
| `lib/api.ts` | `Api`: a thin authenticated `fetch` wrapper against `apps/api` — no generated client exists yet |
| `lib/db.ts` | The one step done with direct SQL: backdating a credit card's own "Starting balance" transaction (see above) |
| `lib/dates.ts` | `todayAt(now, timeZone)`: every date the seed uses, relative to an injected "today" (never read from the clock directly, so it is testable — `lib/dates.test.ts`). The rule it encodes: a *recorded* transaction's date is never after today (`onOrBeforeToday` clamps a fixed day down to today); a scheduled transaction can genuinely be due before or after today (`beforeTodaySameMonth`/`afterTodaySameMonth`, each falling back to the adjacent month at the rare edge — today being the 1st or the month's last day) |
| `explore-env/cli.ts` | `up`, `down` and `sweep` for disposable environments (above) |
| `explore-env/names.ts` | Run ids, database and realm names, and the checks that refuse anything else (`explore-env/names.test.ts`) |
| `explore-env/manifest.ts` | The manifest's shape, the run directory, and reading a manifest back with its names checked |
| `explore-env/postgres.ts` | Creating, migrating, listing and dropping a run's database; the `envelope_app`/`envelope_queue` logins; the editor and reader memberships |
| `explore-env/keycloak.ts` | Creating a run's realm (through `keycloak/bootstrap.sh`), its password-grant client and users; listing and deleting realms; a persona's token |
| `explore-env/processes.ts` | Starting the API and web server detached with their logs, reading their `listening` line, finding and stopping a run's processes |
| `explore-env/static-server.ts` | Serves the built web app on 127.0.0.1, `index.html` for the app's own routes |
| `explore-env/vapid.ts` | A fresh VAPID key pair for each run's API |
