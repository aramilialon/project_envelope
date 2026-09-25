# 0005 — Plain SQL migrations and node-postgres

- **Status:** accepted
- **Date:** 2026-09-26

## Context

The API needs a schema, migrations and queries on PostgreSQL. The main developer knows SQL well and wants to see exactly what runs against the database. The design document originally proposed an ORM with generated migrations.

## Decision

- **Migrations are plain SQL files** in `apps/api/migrations/`, named `NNNN_short_description.sql` (for example `0001_workspaces.sql`) and applied in order.
- A small migration runner applies each pending file in its own transaction and records its name and checksum in a `schema_migrations` table. An applied migration is never edited: changes go into a new file. The runner refuses to start if the checksum of an applied file has changed.
- **Queries are written in SQL** and executed with **node-postgres (`pg`)**, always with parameters (`$1`, `$2`…), never by concatenating values into the text.
- Queries live in one repository module per aggregate (workspaces, accounts, transactions…), which maps rows to typed objects by hand. Route handlers never contain SQL.
- Integration tests run against a real PostgreSQL, in CI as a service container and locally through `infra/docker-compose.yml`.

## Discarded alternatives

- **An ORM with generated migrations:** type-safe queries, but one more abstraction to learn, and generated SQL is harder to review.
- **Another lightweight driver:** the queue library (pg-boss) already depends on `pg`, so using `pg` everywhere means a single driver, a single connection pool configuration and a single set of types.

## Consequences

- What runs on the database is exactly what is in the repository, readable by anyone who knows SQL.
- Row-to-object mapping is manual: repository tests must cover it.
- Migrations can be tested with `psql` alone, without starting the API.
