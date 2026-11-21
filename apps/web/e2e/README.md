# End-to-end tests (Playwright)

Headless Chromium, driven through a real sign-in against the real "envelope" Keycloak realm (or a disposable environment's own realm, below) — the one thing a mocked `useAuth()` unit test cannot prove. Found a real bug on its first real run: `scripts/keycloak/bootstrap.sh`'s `webOrigins` did not actually allow the token exchange's CORS request (`#308`).

## Running locally

Needs, already running:

- PostgreSQL and Keycloak (`cd infra && docker compose up -d`), with the `envelope` realm bootstrapped (`scripts/keycloak/bootstrap.sh`, see `docs/getting-started.md`).
- `apps/api`, with a real `.env` (its own `README.md`).

`apps/web` itself does not need to be running: Playwright's own `webServer` starts `pnpm dev` for the run.

```bash
$ cd apps/web
$ npx playwright install --with-deps chromium   # once, downloads a headless browser
$ cp .env.example .env
$ DATABASE_URL=postgres://envelope:<password>@127.0.0.1:5432/envelope \
  KEYCLOAK_ADMIN_PASSWORD=<password from infra/.env> \
  pnpm test:e2e
```

`keycloak-test-user.ts` creates a throwaway user in the real `envelope` realm through the admin API for each test (self-registration is disabled by design) and removes it afterward — nothing to set up by hand, and nothing left behind. `db.ts` needs `DATABASE_URL` (the superuser connection, the same one `apps/api`'s own tests use for fixture setup — never the restricted `envelope_app` role, since this is test setup, not something exercising Row-Level Security) to create and remove a workspace/membership directly.

## Against a disposable environment

With `E2E_MANIFEST` set to a disposable environment's manifest (`scripts/README.md`, "Disposable environments", `#536`), the suite runs against that environment instead: its own built web app (already running, so no dev server is started), API, realm and database. Nothing in the developer's own `envelope` realm or database is touched, and neither `apps/api` nor `apps/web` needs to be running locally. `DATABASE_URL` is not used: the fixtures connect to the disposable environments' own PostgreSQL server (never the shared one on port 5432, which they refuse), as its superuser, with the password in `~/.config/envelope-explore/postgres-password` (or `EXPLORE_DATABASE_URL` in CI) and the manifest's `postgres` host and port, which must be `127.0.0.1` or `localhost`. The manifest's own directory must be private (ours, not a symbolic link, no group or other permission bits). They still need `KEYCLOAK_ADMIN_PASSWORD`; the manifest holds no credential but the personas'.

```bash
$ pnpm --filter @envelope/scripts explore:up       # prints the manifest's path
$ cd apps/web
$ E2E_MANIFEST=/tmp/envelope-explore/<run>/manifest.json \
  KEYCLOAK_ADMIN_PASSWORD=<password from infra/.env> \
  pnpm test:e2e
$ pnpm --filter @envelope/scripts explore:down <run>
```

The tests create their own throwaway users and workspaces in that realm and database, as they do locally, and leave the environment's personas alone. The web app there is a production build (`vite build`), with its service worker, rather than the dev server.

## Contents

| File | What it does |
| --- | --- |
| `environment.ts` | Where the tests run: the local dev stack by default, or the disposable environment `E2E_MANIFEST` names (its web URL, realm and database) |
| `keycloak-test-user.ts` | `createTestUser()`: a throwaway Keycloak user (admin API), with `teardown()` to remove it; `subject` is Keycloak's own user id, the `sub` claim any token issued to them carries |
| `db.ts` | `findUserIdBySubject(subject)`: the local `users.id` once the user-mapper preHandler has created it; `createWorkspaceWithMembership(userId, name, role?)`: a throwaway workspace with a membership, with `teardown()` to remove it; `setWorkspaceTaxCountry`, `listTaxRegimes` (`#508`) |
| `sign-in.spec.ts` | Signs in through the real Keycloak login form and back, and signs out again (`#49`) |
| `language.spec.ts` | The interface language (`#620`): an Italian browser gets the sign-in screen in Italian with `<html lang="it">`, a Japanese one (not shipped) gets English; with the Italian catalog's request aborted the app still starts, in English; against a disposable environment's build, Italian still shows offline once the service worker has precached the catalog |
| `workspaces.spec.ts` | The workspace switcher (`#50`): the empty-workspace message, skipping straight through a single workspace, the picker once a second one exists, and switching between them |
| `accounts.spec.ts` | The accounts screen (`#51`, `#323`): creating an account from its own "+ Add account", opening its register by clicking its name, and closing it; in a workspace whose tax country is `IT`, creating a brokerage account with its tax regime and withholding agent (`#508`) |
| `categories.spec.ts` | The categories screen (`#52`): reaching it from the workspace switcher's "Workspace settings", adding a group and a category, then archiving the category |
| `budget.spec.ts` | The budget month screen (`#53`): unassigned money at zero and the empty-categories message for a brand new workspace, and month navigation; changing month with a category's detail open closes it, and nothing assigned in one month reaches the other (`#698`) |
| `transactions.spec.ts` | The account register (`#54`): reaching it from the Accounts screen (`#323`), adding an outflow with a category and a transfer to another account, and toggling a transaction's status; a transfer from an off-budget account landing as "Unassigned" by default, then moved to a category by editing it, and a transfer to it still asking for a category; at 360px, the full-screen form's "Add" clear of the tab bar (`#599`); a row dated next year listed under "Later", out of today's balance (register and Accounts screen) and of the "Mark" items, its date with the year (`#702`); on a closed account's register reached by its address, a refused status change says the account is closed and leaves the status as it was (`#741`) |
| `targets.spec.ts` | Targets and quick assign (`#55`): setting a monthly target on a category from the "Targets" panel, seeing it reflected there, and running "Quick assign" with its default scope and mode |
| `reconciliation.spec.ts` | The reconciliation screen (`#60`): a cleared transaction, a matching statement balance, locking it from the account register's own "Reconcile" to-do item, then unlocking it again; on the way, that the statement balance and "As of" fields stay inside the tally panel at 1440px and 390px (`#592`) |
| `import.spec.ts` | The import screen (`#59`): a CSV statement, column mapping, reviewing the staged rows, confirming one into a real transaction |
| `notifications.spec.ts` | Role gating (`#61`): a `read_only` member sees the budget month with no write actions at all. The Web Push opt-in itself is not covered here — headless Chromium's own push stack needs a reachable push service to complete a real subscription, which would make this test slow and flaky for no real product signal; `usePushSubscription`'s own state machine already has solid unit coverage instead |
| `card-debt.spec.ts` | Card debt asked once (`#728`): a category overspent €50 in cash and €300 with a card shows both parts on its row, asks "To do" for its €50 only while the card asks for the €300, and its detail links to the card's payment category, which opens in view with focus on its heading and whose "Assign" asks for the €300 |
| `full-month.spec.ts` | The milestone's own "done when" criterion (`#63`): one continuous journey touching every 0.1.7 screen in a single month — categories, accounts including a credit card's opening debt, assigning and moving money, a plain transaction and a transfer, a card charge keeping its payment category covered, reconciliation, targets, quick assign, a scheduled transaction recorded from its own "To do" item, the instant unresolved-problem toast, import, and days of buffer. Each piece already has its own focused spec; this one only proves they fit together |

## In CI

The `e2e` job in `.github/workflows/ci.yml` runs this suite against a disposable environment, with a PostgreSQL service of its own on port 55432 (`EXPLORE_DATABASE_URL`, throwaway literals) and a Keycloak container started as the job's first step, so it boots while the job installs: it installs Chromium, waits for Keycloak, runs `explore:up`, points `E2E_MANIFEST` at the manifest, runs `pnpm test:e2e`, prints the environment's logs and uploads Playwright's traces (`test-results/`) if anything failed, and runs `explore:down` whatever happened. It times out after 20 minutes. It is **non-blocking for now** (`continue-on-error: true`): a failure shows on the run but does not fail the pull request, until the job has proved stable on CI's runners. Making it blocking is a one-line change.
