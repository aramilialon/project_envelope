# End-to-end tests (Playwright)

Headless Chromium, driven through a real sign-in against the real "envelope" Keycloak realm — the one thing a mocked `useAuth()` unit test cannot prove. Found a real bug on its first real run: `scripts/keycloak/bootstrap.sh`'s `webOrigins` did not actually allow the token exchange's CORS request (`#308`).

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

## Contents

| File | What it does |
| --- | --- |
| `keycloak-test-user.ts` | `createTestUser()`: a throwaway Keycloak user (admin API), with `teardown()` to remove it; `subject` is Keycloak's own user id, the `sub` claim any token issued to them carries |
| `db.ts` | `findUserIdBySubject(subject)`: the local `users.id` once the user-mapper preHandler has created it; `createWorkspaceWithMembership(userId, name, role?)`: a throwaway workspace with a membership, with `teardown()` to remove it |
| `sign-in.spec.ts` | Signs in through the real Keycloak login form and back, and signs out again (`#49`) |
| `workspaces.spec.ts` | The workspace switcher (`#50`): the empty-workspace message, skipping straight through a single workspace, the picker once a second one exists, and switching between them |
| `accounts.spec.ts` | The accounts screen (`#51`): creating an account from the sidebar's "+ Add account", seeing it in the sidebar ledger, and closing it from the dedicated screen |
| `categories.spec.ts` | The categories screen (`#52`): reaching it from the workspace switcher's "Workspace settings", adding a group and a category, then archiving the category |
| `budget.spec.ts` | The budget month screen (`#53`): ready to assign at zero and the empty-categories message for a brand new workspace, and month navigation |
| `transactions.spec.ts` | The account register (`#54`): reaching it from the sidebar ledger, adding an outflow with a category and a transfer to another account, and toggling a transaction's status |

## In CI

Not wired into `.github/workflows/ci.yml` yet: CI's own Keycloak container starts bare, with no `envelope` realm bootstrapped (unlike `apps/api`'s tests, which provision their own throwaway realm per run through `test-helpers/keycloak.ts`). Adding a CI step for this needs, in order: `scripts/keycloak/bootstrap.sh` run once against CI's Keycloak container, `apps/api` started with a real `.env` (not just migrated, the way its own integration tests use it), then `npx playwright install --with-deps chromium` and `pnpm test:e2e`. The dependency itself is already committed (`@playwright/test` in `package.json`/`pnpm-lock.yaml`), so none of that needs a second install step when this is set up.
