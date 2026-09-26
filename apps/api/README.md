# @envelope/api

The backend server: a Fastify HTTP API on top of PostgreSQL. Step 1 of the backend MVP (see `CLAUDE.md`) is just a skeleton: configuration, a database pool, a migration runner and a `/health` endpoint, all with integration tests against a real PostgreSQL.

## Contents

| File | What it does |
| --- | --- |
| `src/config.ts` | Reads and validates environment variables once at startup |
| `src/db/pool.ts` | The only file that imports `pg` directly; everything else gets a connection pool from here |
| `src/db/migrate.ts` | Applies pending SQL files from `migrations/`, also runnable as `pnpm --filter @envelope/api migrate` |
| `migrations/` | Plain SQL migration files (ADR 0005); empty until step 2 adds the domain schema |
| `src/routes/health.ts` | `GET /health`: reports whether the database is reachable |
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
| `HOST` | `127.0.0.1` | Address the server listens on |
| `PORT` | `3000` | Port the server listens on |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `LOG_PRETTY` | `false` | Human-readable logs instead of JSON; only for a terminal, never in production |
| `NODE_ENV` | `development` | |

A missing or invalid variable makes the process exit immediately with a clear error, instead of failing later somewhere unrelated.

## Running the integration tests locally

The tests need their own database, separate from the one used for everyday development, so a broken test never touches real data:

```bash
$ createdb -h 127.0.0.1 -U envelope envelope_test   # once, asks for the password in infra/.env
$ DATABASE_URL=postgres://envelope:<password>@127.0.0.1:5432/envelope_test pnpm --filter @envelope/api test
```

CI does the same against a fresh PostgreSQL service container: see `.github/workflows/ci.yml`.

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

## Current limitations

No authentication yet (step 3), no domain schema yet (step 2): `/health` is the only route, and it only checks that the database is reachable.
