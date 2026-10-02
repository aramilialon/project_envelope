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
invariant only holds if the data was built the way the real app builds it. The one exception:
there is no HTTP endpoint yet to create or delete a workspace and its first membership, so that
one step (`lib/db.ts`) uses direct SQL, clearly isolated — everything else (accounts, categories,
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
After seeding, it verifies `@envelope/core`'s own invariant (unassigned money + every category's
available + reserved + assigned to future months + credit overspending = the on-budget cash
accounts' own balance, cards excluded) the same way `apps/web` itself could: from the budget
month endpoint and each cash account's own transaction list, never a direct query. A broken
invariant fails the script loudly.

### Running locally

Needs, already running: PostgreSQL and Keycloak (`cd infra && docker compose up -d`, with the
`envelope` realm bootstrapped, `docs/getting-started.md`), and `apps/api` with a real `.env`
(`apps/api/README.md`).

```bash
$ cd scripts
$ cp .env.example .env   # fill in DATABASE_URL, KEYCLOAK_ADMIN_PASSWORD, DEMO_USER_PASSWORD
$ pnpm seed:demo
```

Refuses to run if `NODE_ENV=production`, or if `API_URL` does not resolve to
`127.0.0.1`/`localhost` — this creates and deletes a whole workspace, never something to risk
against a real deployment. A "Demo" workspace already existing makes it exit immediately with a
message; pass `--reset` to delete the previous one first and seed fresh:

```bash
$ pnpm seed:demo -- --reset
```

The persistent "demo" Keycloak user (not a throwaway one, unlike the end-to-end tests' own) is
created on first run and left alone afterward; sign in as it with the password in
`DEMO_USER_PASSWORD` to look around.

### Reference screenshots

`screenshot-demo.ts` regenerates the reference screenshots from the already-seeded "Demo"
workspace: light and dark, 1440px and 390px, for the budget month and the account register,
named after `docs/ux/screenshots/budget-month-*.png`/`account-register.png`'s existing convention
(with a size suffix, since those were only ever one size). Needs `apps/web` running too (not just
`apps/api`), since unlike the seed script's own plain-`fetch` handshake, this drives the real
sign-in form through a real (headless) browser to actually render pixels.

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
| `lib/env.ts` | `requireEnv`: fails fast on a missing variable; `assertSafeToRun`: refuses `NODE_ENV=production` or a non-local `API_URL` |
| `lib/keycloak.ts` | `ensureDemoUser`/`signInAsDemoUser`: the persistent demo user and the browser-free PKCE handshake; `subjectOf`: an access token's own `sub` claim |
| `lib/api.ts` | `Api`: a thin authenticated `fetch` wrapper against `apps/api` — no generated client exists yet |
| `lib/db.ts` | The one step done with direct SQL: creating/deleting the "Demo" workspace and its first membership (see above) |
