# Changelog

All notable changes to envelope are listed here, newest first. Versions follow semantic versioning: 1.0.0 marks the whole product (budget, portfolio, mobile and everything else in `docs/design.md`), so every 0.x.y release is still pre-1.0 by design, however usable a given 0.x.0 milestone group already is on its own. A new minor version (0.x.0) starts a milestone group (Budget, Portfolio, Mobile, ...); each patch release (0.x.y) closes one milestone within that group.

Each entry groups changes under **Added**, **Changed**, **Fixed** and **Removed**.

## [Unreleased]

### Added

- `@envelope/core`: `computeBudgetMonth` takes each on-budget credit card's real balance and returns `uncovered` per payment category — debt not yet covered by assigned money, derived fresh every call instead of being swept to zero at month-end or silently lost (`#249`).

### Changed

- Documentation: the portfolio mockup and its "User interface" section no longer describe holdings left unassigned to any portfolio, aligning them with #219 (every trade is assigned to exactly one portfolio when it is entered).
- Documentation: monthly assignments recorded as an append-only ledger instead of a mutable per-category total (ADR 0008); credit card debt shown as derived rather than persisted; scheduled transactions reserve money instead of only appearing once recorded; import stages rows until categorized instead of a "to categorize" state in `transactions`; sync's conflict-loser notice; foreign-currency budget accounts deferred to after 1.0.0.

## [0.1.2] - 2026-09-26

### Added

- GitHub workflow: labels and milestones, protected main branch, pull request template, commit convention checked by a Git hook and by CI on pull request titles.
- `apps/api`: Keycloak access token verification against the realm's JWKS (signature, issuer, audience, expiry), as a Fastify preHandler not yet wired into any route (`#6`).
- `apps/api`: maps a verified access token's `sub`/`email` claims to a local `users` row, creating it on first sign-in and keeping the email in sync, as a Fastify preHandler chained after token verification (`#7`).
- Documentation: user interface design (principles, visual language, budget month on desktop and phone, other screens, target calculation) and interactive mockups in `docs/ux/mockups/`: budget month, account register, import and reconciliation, settings and first run, portfolio.
- README rewritten around what the app does, with screenshots of the mockups, principles, status and roadmap.
- Documentation: import and reconciliation rules (duplicate detection, transaction states, statement difference, adjustments, locking); portfolios can share a brokerage account, with every trade assigned to one portfolio; ideas kept for after 1.0.0 (place-aware suggestions on the phone, optional receipt reading).
- `apps/api`: checks the local user's role in the workspace a request names and opens the request's single database transaction with the session variables ADR 0006's Row-Level Security policies expect, as a Fastify preHandler chained after user mapping (`#8`).
- `apps/api`: the server now connects to PostgreSQL as the restricted `envelope_app` role (`APP_DATABASE_URL`) instead of the migration runner's superuser, so Row-Level Security is enforced for the running server, not just proven in tests (`#9`).
- `apps/api`: an append-only `audit_log` table (workspace-scoped, Row-Level Security, no `UPDATE`/`DELETE` grant to `envelope_app`) and a single `recordAuditLog` write helper other repositories can call (`#216`).
- `apps/api`: token verification and user mapping are now global preHandlers, applied to every route except `/health`, so a new route rejects a missing or foreign token without repeating the preHandler wiring itself (`#10`).
- `scripts/keycloak/bootstrap.sh`: creates the real `envelope` realm and its `envelope-api` client (public, PKCE, an audience mapper) in the development Keycloak, idempotently, replacing manual console setup (`#71`).
- `apps/api`: `GET /me` returns the caller's local user id, protected by the existing global preHandlers; registered only outside production, since it exists to give tests a real route ahead of the Budget API's own (`#235`).

### Changed

- Neutral names for two budget concepts: "ready to assign" is now **unassigned** (`BudgetMonth.unassigned`, the income category id `UNASSIGNED` = `"unassigned"`), and "age of money" is now **days of buffer**; the budget goals and the first run are described in the project's own words.
- The `main` branch ruleset now only allows "Squash and merge" and also requires the `conventional-title` check to pass, alongside `test`; the repository is public, so this works on the free plan.

## [0.1.1] - 2026-09-26

### Added

- Domain schema: workspaces, users, memberships, accounts, categories and groups, transactions with splits and transfers, monthly assignments.
- Row-Level Security per workspace, enforced against a dedicated `envelope_app` database role and proven by integration tests that two workspaces cannot see each other's rows (ADR 0006).

## [0.1.0] - 2026-09-26

### Added

- Monorepo with strict TypeScript configuration and CI.
- `@envelope/core`: integer money amounts with locale-aware parsing and formatting, months and local dates, translatable validation errors.
- Budget month calculation: ready to assign, rollover, future assignments, cash and credit overspending, credit card payment categories.
- Transaction aggregation: income, splits, transfers, card payments, off-budget accounts.
- Development environment: docker-compose for PostgreSQL and Keycloak, Ansible playbook for a Debian 13 development machine.
- Documentation: design document, getting started, how-to guides, ADRs 0001–0005, glossary.
- `apps/api` skeleton: Fastify server, validated environment configuration, structured logs, a `/health` endpoint, a PostgreSQL connection pool, a plain-SQL migration runner with checksum tracking (ADR 0005), and integration tests against a real PostgreSQL with a CI service container.
