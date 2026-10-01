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
$ KEYCLOAK_ADMIN_PASSWORD=<password from infra/.env> pnpm test:e2e
```

`keycloak-test-user.ts` creates a throwaway user in the real `envelope` realm through the admin API for each test (self-registration is disabled by design) and removes it afterward — nothing to set up by hand, and nothing left behind.

## Contents

| File | What it does |
| --- | --- |
| `keycloak-test-user.ts` | `createTestUser()`: a throwaway Keycloak user (admin API), with `teardown()` to remove it |
| `sign-in.spec.ts` | Signs in through the real Keycloak login form and back, and signs out again (`#49`) |

## In CI

Not wired into `.github/workflows/ci.yml` yet: CI's own Keycloak container starts bare, with no `envelope` realm bootstrapped (unlike `apps/api`'s tests, which provision their own throwaway realm per run through `test-helpers/keycloak.ts`). Adding a CI step for this needs, in order: `scripts/keycloak/bootstrap.sh` run once against CI's Keycloak container, `apps/api` started with a real `.env` (not just migrated, the way its own integration tests use it), then `npx playwright install --with-deps chromium` and `pnpm test:e2e`. The dependency itself is already committed (`@playwright/test` in `package.json`/`pnpm-lock.yaml`), so none of that needs a second install step when this is set up.
