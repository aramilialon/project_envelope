# @envelope/api

The backend server: a Fastify HTTP API on top of PostgreSQL. Steps 1 to 3 of the backend MVP (see `CLAUDE.md`) are done: configuration, a database pool, a migration runner, the domain schema and Row-Level Security per workspace, and authentication — Keycloak access tokens verified against the realm's JWKS, mapped to a local `users` row, workspace membership checked with the request's Row-Level Security session variables set. Token verification and user mapping are global preHandlers, applied to every route except `/health`; workspace membership stays an explicit per-route opt-in. Step 4 (Budget API) is in progress: accounts are in, with their payment category and optional starting balance for on-budget credit cards; so are category groups and categories, sortable and archivable.

## Contents

| File | What it does |
| --- | --- |
| `src/config.ts` | Reads and validates environment variables once at startup |
| `src/db/pool.ts` | The only file that imports `pg` directly; everything else gets a connection pool from here |
| `src/db/migrate.ts` | Applies pending SQL files from `migrations/`, also runnable as `pnpm --filter @envelope/api migrate` |
| `migrations/` | Plain SQL migration files (ADR 0005): the domain schema and its Row-Level Security policies (ADR 0006) |
| `src/routes/health.ts` | `GET /health`: reports whether the database is reachable |
| `src/routes/me.ts` | `GET /me`: returns the caller's local user id; registered only outside production, to give the global auth preHandlers a real route to protect ahead of the Budget API's own routes |
| `src/routes/accounts.ts` | `POST`/`GET /workspaces/:workspaceId/accounts`, `PATCH .../:accountId/close` |
| `src/accounts/repository.ts` | Create (with its payment category and optional starting balance for an on-budget credit card), list, close an account (ADR 0005) |
| `src/routes/categories.ts` | `POST`/`GET .../category-groups`, `PATCH .../category-groups/:groupId/archive`, `PUT .../category-groups/reorder`; the same four for `.../categories`, plus `PUT .../category-groups/:groupId/categories/reorder` |
| `src/categories/repository.ts` | Create, list, archive, reorder category groups and categories (ADR 0005); reordering rewrites every affected row's `sort_order` in one go, rejecting a partial or foreign id set |
| `src/auth/token-verifier.ts` | Verifies a Keycloak access token's signature (against the realm's JWKS), issuer, audience and expiry; a Fastify preHandler that attaches the decoded claims to `request.auth` |
| `src/auth/user-mapper.ts` | Fastify preHandler, chained after the token verifier: upserts a `users` row from the token's `sub`/`email` claims and attaches its id to `request.userId` |
| `src/auth/workspace-membership.ts` | Fastify preHandler, chained after the user mapper: checks the local user's role in the workspace the request names, and opens the request's single database transaction with `app.user_id`/`app.workspace_id` set for ADR 0006's RLS policies; `registerWorkspaceScope` commits or rolls it back once the response is ready |
| `src/users/repository.ts` | The `users` table's only entry point for queries (ADR 0005) |
| `src/test-helpers/keycloak.ts` | Provisions a throwaway Keycloak realm, clients and user for tests, through the admin REST API |
| `src/test-helpers/app-role.ts` | Grants `envelope_app` a test-only login (idempotently, cluster-wide) so tests can connect as the same restricted role the running server uses |
| `src/app.ts` | `buildApp(config)`: assembles the Fastify instance and its routes, without opening a port (used directly by tests) |
| `src/main.ts` | Entry point: loads the config, builds the app, starts listening |
| `*.test.ts` | Tests, next to the file they check |

## Commands

```bash
pnpm --filter @envelope/api dev          # start with auto-restart on file changes
pnpm --filter @envelope/api start        # start once
pnpm --filter @envelope/api migrate      # apply pending migrations
pnpm --filter @envelope/api test         # integration tests, then smoke tests, each in its own clearly separated node --test run
pnpm --filter @envelope/api typecheck
```

## Configuration

Copy `.env.example` to `.env` and adjust it; `.env` is read automatically by `dev`/`start`/`migrate` and is ignored by Git.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — (required by `migrate`) | The migration runner's connection: needs DDL privileges, so it's the superuser (`envelope`) |
| `APP_DATABASE_URL` | — (required by `dev`/`start`) | The running server's own connection: `envelope_app`, restricted by Row-Level Security (ADR 0006) |
| `KEYCLOAK_ISSUER` | — (required) | The realm's issuer URL, e.g. `http://127.0.0.1:8080/realms/envelope`; also where the JWKS is fetched from |
| `KEYCLOAK_AUDIENCE` | — (required) | The client id every access token must be issued for |
| `HOST` | `127.0.0.1` | Address the server listens on |
| `PORT` | `3000` | Port the server listens on |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `LOG_PRETTY` | `false` | Human-readable logs instead of JSON; only for a terminal, never in production |
| `NODE_ENV` | `development` | |

A missing or invalid variable makes the process exit immediately with a clear error, instead of failing later somewhere unrelated. `DATABASE_URL` and `APP_DATABASE_URL` are two different connections on purpose (ADR 0006): the first can create tables, the second cannot even see another workspace's rows.

### Giving `envelope_app` a login

Migrations create the `envelope_app` role but deliberately never give it `LOGIN` or a password (ADR 0006: that would mean committing a real credential to the repository). Do it once per Postgres instance, the same way `infra/.env` already holds the `envelope` and Keycloak passwords:

```bash
$ docker exec -it envelope-postgres-1 psql -U envelope -d envelope \
  -c "ALTER ROLE envelope_app WITH LOGIN PASSWORD '<a password you pick>';"
```

Roles are shared by the whole Postgres instance (not per database), so this one command covers both the `envelope` and `envelope_test` databases. Use that password in `APP_DATABASE_URL`.

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
| `request.db` held open for the whole request, `onResponse`/`onError` commit or roll it back | `$dbh->begin_work` at the top of a CGI script, `$dbh->commit` at the bottom, `$dbh->rollback` in the `die` handler | One connection, one transaction per request, so every query in that request sees the same `SET LOCAL` session variables |

## Current limitations

No repository/route code yet (step 4) beyond the users table: `/health` is still the only route, and no query touches the rest of the domain schema except in tests. The API now connects as the restricted `envelope_app` role by default (`APP_DATABASE_URL`), so the Row-Level Security policies in [ADR 0006](../../docs/adr/0006-row-level-security.md) are enforced for real, not just proven with `SET ROLE` (`src/db/schema.test.ts`) or by inspecting session variables (`src/auth/workspace-membership.test.ts`) — `src/auth/workspace-isolation.test.ts` proves it end to end, through a real HTTP request. Token verification, user mapping and workspace membership all exist and are tested individually, but nothing registers them globally yet, so no real route rejects an invalid token or an unauthorized workspace today; that, plus the actual budget endpoints, come in step 4.
