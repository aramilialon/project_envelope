# Changelog

All notable changes to envelope are listed here, newest first. Versions follow semantic versioning: 1.0.0 marks the whole product (budget, portfolio, mobile and everything else in `docs/design.md`), so every 0.x.y release is still pre-1.0 by design, however usable a given 0.x.0 milestone group already is on its own. A new minor version (0.x.0) starts a milestone group (Budget, Portfolio, Mobile, ...); each patch release (0.x.y) closes one milestone within that group.

Each entry groups changes under **Added**, **Changed**, **Fixed** and **Removed**.

## [Unreleased]

### Added

- GitHub workflow: labels and milestones, protected main branch, pull request template, commit convention checked by a Git hook and by CI on pull request titles.
- `apps/api`: Keycloak access token verification against the realm's JWKS (signature, issuer, audience, expiry), as a Fastify preHandler not yet wired into any route (`#6`).
- `apps/api`: maps a verified access token's `sub`/`email` claims to a local `users` row, creating it on first sign-in and keeping the email in sync, as a Fastify preHandler chained after token verification (`#7`).

### Changed

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
