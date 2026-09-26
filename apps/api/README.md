# @envelope/api

The backend server: a Fastify HTTP API on top of PostgreSQL. Steps 1 and 2 of the backend MVP (see `CLAUDE.md`) are done: configuration, a database pool, a migration runner, a `/health` endpoint, the domain schema (workspaces, users, memberships, accounts, categories, transactions, monthly assignments) and Row-Level Security per workspace, all with integration tests against a real PostgreSQL. Step 3 (authentication) is in progress: Keycloak access tokens are verified against the realm's JWKS and mapped to a local `users` row, but neither is wired into any route yet.

## Contents

| File | What it does |
| --- | --- |
| `src/config.ts` | Reads and validates environment variables once at startup |
| `src/db/pool.ts` | The only file that imports `pg` directly; everything else gets a connection pool from here |
| `src/db/migrate.ts` | Applies pending SQL files from `migrations/`, also runnable as `pnpm --filter @envelope/api migrate` |
| `migrations/` | Plain SQL migration files (ADR 0005): the domain schema and its Row-Level Security policies (ADR 0006) |
| `src/routes/health.ts` | `GET /health`: reports whether the database is reachable |
| `src/auth/token-verifier.ts` | Verifies a Keycloak access token's signature (against the realm's JWKS), issuer, audience and expiry; a Fastify preHandler that attaches the decoded claims to `request.auth` |
| `src/auth/user-mapper.ts` | Fastify preHandler, chained after the token verifier: upserts a `users` row from the token's `sub`/`email` claims and attaches its id to `request.userId` |
| `src/users/repository.ts` | The `users` table's only entry point for queries (ADR 0005) |
| `src/test-helpers/keycloak.ts` | Provisions a throwaway Keycloak realm, clients and user for tests, through the admin REST API |
| `src/app.ts` | `buildApp(config)`: assembles the Fastify instance and its routes, without opening a port (used directly by tests) |
| `src/main.ts` | Entry point: loads the config, builds the app, starts listening |
| `*.test.ts` | Tests, next to the file they check |

## Commands

```bash
pnpm --filter @envelope/api dev          # start with auto-restart on file changes
pnpm --filter @envelope/api start        # start once
pnpm --filter @envelope/api migrate      # apply pending migrations
pnpm --filter @envelope/api test         # integration tests (needs a running PostgreSQL, see below)
pnpm --filter @envelope/api typecheck
```

## Configuration

Copy `.env.example` to `.env` and adjust it; `.env` is read automatically by `dev`/`start`/`migrate` and is ignored by Git.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `KEYCLOAK_ISSUER` | — (required) | The realm's issuer URL, e.g. `http://127.0.0.1:8080/realms/envelope`; also where the JWKS is fetched from |
| `KEYCLOAK_AUDIENCE` | — (required) | The client id every access token must be issued for |
| `HOST` | `127.0.0.1` | Address the server listens on |
| `PORT` | `3000` | Port the server listens on |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `LOG_PRETTY` | `false` | Human-readable logs instead of JSON; only for a terminal, never in production |
| `NODE_ENV` | `development` | |

A missing or invalid variable makes the process exit immediately with a clear error, instead of failing later somewhere unrelated.

## Running the integration tests locally

The tests need their own database, separate from the one used for everyday development, so a broken test never touches real data. They also need `KEYCLOAK_ADMIN_PASSWORD` (the value from `infra/.env`): the Keycloak tests provision and tear down their own realm through the admin API, so no manual realm setup is needed to run them.

```bash
$ createdb -h 127.0.0.1 -U envelope envelope_test   # once, asks for the password in infra/.env
$ DATABASE_URL=postgres://envelope:<password>@127.0.0.1:5432/envelope_test \
  KEYCLOAK_ADMIN_PASSWORD=<password from infra/.env> \
  pnpm --filter @envelope/api test
```

CI does the same against a fresh PostgreSQL service container and a Keycloak container it starts and waits on: see `.github/workflows/ci.yml`.

## Things to understand

Comparisons with Perl/CGI/DBI, to find your way around the code.

| In this code | In Perl/CGI/DBI | Note |
| --- | --- | --- |
| `loadConfig()` reading `process.env` | Reading `%ENV` in a CGI script, or a `.ini` parsed by hand | Done once, in one place, with validation, instead of scattered `$ENV{...}` reads |
| `pg.Pool` | `Apache::DBI` or a `DBI->connect_cached` | Keeps a handful of open connections ready, instead of connecting on every request |
| `pool.query("SELECT 1", [...])` with `$1, $2` | `$dbh->prepare("... WHERE id = ?")->execute($id)` | Same idea: parameters are sent separately from the SQL text, never concatenated into it |
| `src/db/migrate.ts` | Running `psql -f change.sql` by hand and noting down which ones you already ran | The runner tracks what has been applied in a table (`schema_migrations`), so it never reapplies or forgets a file |
| Fastify route handler (`app.get("/health", async (req, reply) => ...)`) | A `mod_perl` handler subroutine, or a CGI script mapped to a URL | Same shape: receives a request, returns a response; Fastify keeps the process running instead of forking per request |
| `app.fastify.inject({ method: "GET", url: "/health" })` in tests | Calling the handler subroutine directly with a fake request, instead of going through Apache | No real socket, so tests are fast and do not need a free port |
| Structured JSON logs (`pino`, built into Fastify) | `Log::Log4perl` with a line-based format, or `warn()` to STDERR | One JSON object per line, with a level and a timestamp, easy to filter and ship to a log collector |
| `process.on("SIGTERM", ...)` | `$SIG{TERM} = sub { ... }` | Same idea: close connections cleanly before the process actually exits |
| `createRemoteJWKSet` + `jwtVerify` (`jose`) | Checking a signed cookie or a Kerberos ticket against a key you fetch once and cache | Keycloak signs the token with a private key only it holds; the API only ever sees the matching public keys, published at a URL, and never has to trust the caller's word for who they are |

## Current limitations

No repository/route code yet (step 4) beyond the users table: `/health` is still the only route, and no query touches the rest of the domain schema except in tests. Because of that, the API's own connection still uses the superuser role (`envelope`) from `infra/.env`, which bypasses the Row-Level Security policies described in [ADR 0006](../../docs/adr/0006-row-level-security.md); those policies are proven correct by `src/db/schema.test.ts` (using `SET ROLE envelope_app`), not yet enforced for the running server. Access-token verification and user mapping exist and are tested, but nothing calls them yet: checking workspace membership and registering both preHandlers globally so every route rejects an invalid token are the next issues in `v0.3.0`.
