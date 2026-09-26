# CLAUDE.md

Guidance for Claude Code when working in this repository. Read [docs/design.md](docs/design.md) before any non-trivial change: it is the reference for features, architecture, roadmap and decisions. Decisions with lasting impact are recorded in [docs/adr/](docs/adr/).

## What this is

`envelope` (code name) is a self-hosted web and mobile app that combines envelope budgeting with investment portfolios, target allocation and threshold-based rebalancing. The current goal is personal and family use; the architecture is multi-user (workspaces) from day one.

## Non-negotiable rules

- **English only** in everything that goes into the repository: code, comments, tests, documentation, commit messages.
- **No references to external products or people** that inspired the project (other budgeting apps, bloggers, data providers, named model portfolios). Only name the components the stack actually uses (PostgreSQL, Keycloak, React, Expo, pg-boss…).
- **No advice.** The app computes what the user's own targets and thresholds require; it never recommends instruments and uses neutral wording ("To get back to your targets:").
- **No user-facing text in `packages/core`.** It returns data and `ValidationError`s with a stable `code` and `details`; the UI translates them (ADR 0004).
- **Amounts are integers in minor units** (`Cents`), never floating point (ADR 0002). Dates are stored in UTC; the budget month of a transaction uses the workspace's time zone.
- **Never commit secrets.** `.env`, `infra/ansible/vars.yml`, `infra/ansible/inventory.ini` and `.github-token` are ignored by Git.
- **Documentation moves with the code.** Every change updates the docs it affects; if a how-to guide is not enough to repeat a change, fix the guide.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Pure domain logic, no dependencies: money, months and dates, budget month, credit cards, transaction aggregation |
| `apps/` | `api` (next), then `web` and `mobile` |
| `infra/docker-compose.yml` | PostgreSQL and Keycloak for development, bound to 127.0.0.1 |
| `infra/ansible` | Playbook that prepares a Debian 13 development machine |
| `docs/` | Design document, getting started, how-to guides, ADRs, glossary |
| `scripts/` | GitHub setup (labels, milestones, ruleset) and Git hooks |

## Commands

```bash
pnpm install                          # dependencies (pnpm version pinned in package.json)
pnpm test                             # all tests
pnpm typecheck                        # TypeScript checks
pnpm --filter @envelope/core test     # one package
cd infra && docker compose up -d      # PostgreSQL and Keycloak (needs infra/.env)
```

## Code conventions

- TypeScript run directly by Node.js 24 with type stripping: `erasableSyntaxOnly` is on, so no `enum`, no `namespace`, no constructor parameter properties. Relative imports keep the `.ts` extension.
- Strict compiler options (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- The core is tested with `node:test` and `node:assert`, tests next to the code (`*.test.ts`). Keep the invariant tests passing: they prove that the money in the budget always matches the money in the accounts.
- Data access: plain SQL migrations and parameterized queries with node-postgres, in repository modules; no SQL in route handlers (ADR 0005).
- Background jobs go through the queue module interface (`enqueue`, `schedule`, `work`) with an outbox, deduplication keys, the `processed_jobs` register and a mandatory double-delivery test (design document, "Queue module").
- Authentication: Keycloak as identity provider; the app speaks OpenID Connect only.

## Git and GitHub workflow

Every change reaches `main` through a pull request that the maintainer reviews and merges. Details in [docs/how-to/work-with-issues-and-pull-requests.md](docs/how-to/work-with-issues-and-pull-requests.md).

- **Never** commit on `main`, push to `main`, merge or approve a pull request, force-push, or skip hooks. `.claude/settings.json` denies these commands; do not try other forms of them.
- Work on the issue's milestone. Create a branch `<type>/<issue>-<short-description>` from an up-to-date `main` (types: `feat`, `fix`, `chore`, `docs`).
- Commit messages in English, first line `<type>(<scope>): <description>` in imperative mood, and `Refs #<issue>` in the body. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`; scopes: `core`, `api`, `web`, `mobile`, `infra`, `deps` (optional); `!` after the type or scope marks a breaking change. The `commit-msg` hook rejects other formats.
- The pull request title follows the same format: with "Squash and merge" it becomes the commit message on `main`, and CI checks it.
- When the work is done and tested: push the branch, open a pull request with `gh pr create` filling in the template (`Closes #<issue>`), then stop and report the pull request link.
- Update `CHANGELOG.md` under "Unreleased" for user-visible changes.
- Releases (tags, GitHub releases) are done only when asked.

## Current focus: backend MVP

Build `apps/api` in small increments, each with tests and a green CI. Each increment is a GitHub milestone (`v0.1.0` to `v0.7.0`); split it into issues before starting:

1. Skeleton: Fastify server, configuration, structured logs, health endpoint, PostgreSQL connection, migration runner, integration tests against a real PostgreSQL (CI service container).
2. Schema: users, workspaces, memberships, accounts, categories and groups, transactions with splits and transfers, monthly assignments; Row-Level Security per workspace.
3. Authentication: verify Keycloak access tokens (OIDC, JWKS), map users, check workspace membership and role.
4. Budget API: accounts, categories, transactions, assignments, and the budget month computed by `@envelope/core`.
5. CSV/OFX import with duplicate detection, and reconciliation.
6. Queue and notifications.
7. Field-level sync protocol (design document, "Offline sync and mobile").

Then the web app (phase 1 of the roadmap), with the i18n library chosen in its own ADR.

## Known limitations of the core

Credit card starting balances, income on credit cards, transfers between credit cards and uncategorized transactions are not supported yet (see `packages/core/README.md`).
