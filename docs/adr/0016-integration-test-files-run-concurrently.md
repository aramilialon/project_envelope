# 0016 — The API's integration test files run concurrently

- **Status:** accepted
- **Date:** 2026-11-22

Extends [ADR 0007](0007-per-milestone-smoke-tests.md) and [ADR 0013](0013-model-based-random-walk-tests.md).

## Context

`apps/api`'s integration tests ran one file at a time (`node --test --test-concurrency=1`). The rule dated from when `db/migrate.test.ts` created and deleted rows in the shared `schema_migrations` table that every other file migrates through. Since then every file has come to work on its own data: its own workspaces, users and Keycloak realm, per-database test login roles instead of changes to the shared `envelope_app` and `envelope_queue` logins (#585), and a throwaway database for each job that reads the whole database (#519). The serial run had grown to almost six minutes, of which the random walk's single file took more than one; four files at a time took the same suite to about two and a half minutes, green (#638).

Three things were still shared by every file of a run: the migration runner, which every file calls at the start and which two processes could run at once (two `CREATE TABLE IF NOT EXISTS schema_migrations`, or the same migration applied twice); `migrate.test.ts`'s own rows in that table; and the random walk's file, which on its own would still decide when a concurrent run ends.

## Decision

- **Integration test files run concurrently.** `test:integration` runs `node --test` with `--test-concurrency` taken from `API_TEST_CONCURRENCY`, and when it is not set, Node.js's own default: the available cores minus one (`os.availableParallelism() - 1`), at least one. The smoke tests (ADR 0007) still run one file at a time: each starts a real server process, and there are few of them.
- **Every integration test file must be safe to run alongside every other one.** It creates the data it needs in workspaces of its own and removes only that data; it never counts, lists or deletes rows across the whole database; code under test that reads the whole database (a job that enumerates every workspace, a migration's effect on existing rows) runs on a throwaway database of its own (`test-helpers/isolated-database.ts`); a queue worker it starts must not depend on being the only worker of its queue; it never changes a server-wide object (a role's login or password, a setting) that another file uses. `apps/api/README.md` lists these rules; a file that cannot follow them is a bug, not a reason to go back to serial runs.
- **The migration runner holds a PostgreSQL advisory lock** while it reads and applies migrations (`runMigrations`, `db/migrate.ts`): a session-level `pg_advisory_lock` on one fixed key, on one connection, released when it is done. Advisory locks belong to one database, so runs against other databases never wait on each other. The lock protects real deployments too: two instances of the API, or an instance and `pnpm migrate`, starting at once apply each migration once.
- **`migrate.test.ts` works on a throwaway database of its own**, so its fixtures never touch the run's `schema_migrations`, and it proves the lock: several `runMigrations` started at once apply each migration exactly once.
- **The random walk is one file per seed or check** in `src/test-helpers/walk/`: `seed-1.test.ts` and `seed-20261120.test.ts` (both CI seeds are kept, ADR 0013), `determinism.test.ts`, `regressions.test.ts` and `fetch.test.ts`, sharing their setup through `suite.ts`; `walk.test.ts` runs a walk only on demand (`WALK_SEED`, `WALK_REPLAY`). A new CI seed, or a new kind of walk check, gets a file of its own. No walk file takes much longer than the slowest of the other integration files, so none holds up the end of the run.

## Discarded alternatives

- **Keep the serial run.** Every file already worked on its own data; the run only waited.
- **A fixed concurrency in the script** (for example 4). It would leave cores idle on a larger machine and overload a smaller one; Node.js's own default fits both, and the variable lets a developer or CI choose.
- **Migrate once before the run and drop the call from every file.** Every file would then depend on a step outside it, and a single file run on its own (`node --test <file>`) on a fresh database would fail; the lock costs nothing when there is nothing to apply.
- **Split the random walk by step ranges of one seed.** A walk's steps depend on every earlier step, so a range cannot start without walking the steps before it.

## Consequences

- The full integration run takes less than half as long on a development machine (`apps/api/README.md`, "Running the integration tests locally", has the numbers).
- A file that is not safe to run alongside the others fails some runs and not others. A flaky failure in the integration tests is first suspected of sharing something, and `API_TEST_CONCURRENCY=1` is the way to check.
- Each walk file builds its own app, Keycloak realm and users, so the walk's setup runs five times instead of once; one realm per run (#639) takes most of that away.
- Several runs on one machine, each against a database of its own, now add up: each uses as many processes as the machine has cores. Set `API_TEST_CONCURRENCY` lower when running more than one at a time.
