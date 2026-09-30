# @envelope/api

The backend server: a Fastify HTTP API on top of PostgreSQL. Steps 1 to 4 of the backend MVP (see `CLAUDE.md`) are done: configuration, a database pool, a migration runner, the domain schema and Row-Level Security per workspace, and authentication — Keycloak access tokens verified against the realm's JWKS, mapped to a local `users` row, workspace membership checked with the request's Row-Level Security session variables set. Token verification and user mapping are global preHandlers, applied to every route except `/health`; workspace membership stays an explicit per-route opt-in. Step 4, the Budget API: accounts, with their payment category and optional starting balance for on-budget credit cards; category groups and categories, sortable and archivable; transactions, with splits, income, reconciliation locking and transfers between accounts; the assignment ledger, an append-only record of assign/unassign/move money, with undo; the budget month itself, computed by `@envelope/core` from all of the above, plus its own list of unresolved problems, derived from that same computation; goals (targets), one per category, joined with how much each still needs this month; days of buffer, recomputed from real transactions; quick assign, funding a whole scope of categories in one ledger batch. Every endpoint that changes budget data rejects a `read_only` member; `owner` and `editor` can write, everyone can read. Step 5 (Import) has started: CSV files, given a column mapping remembered per account, and OFX, QIF and CAMT.053 statement downloads, self-describing and needing no mapping, are staged with duplicate detection against the account's existing transactions before being confirmed into real transactions. Reconciliation ties a statement's closing balance to the cleared transactions up to that date, resolving a real leftover difference with an adjustment transaction; unlocking a reconciled transaction is a separate, audited action. Step 6 (Queue and notifications) has started: a `QueueDriver` interface (`enqueue`, `schedule`, `work`) behind which the rest of the code never sees pg-boss directly, now wired into `main.ts` and creating a transaction or a transfer, which queues a `budget-recompute` job in the same database transaction as the write that triggers it. Every job delivery is idempotent by construction: `processed_jobs` discards a repeat before its handler ever runs. Push notification delivery has one interface and, for now, one real adapter — Web Push, keyed by the triggering job's id so a duplicate delivery coalesces on the device instead of showing twice; APNs and Android/FCM are stubs until the mobile app (0.3.0) gives them a real device to send to. The `budget-recompute` job now runs for real: it notifies every workspace member when a category goes negative, a purchase exceeds the available balance, or money arrives to assign, but only when that problem is new or its amount has changed since the last time. Step 7 (Sync) has started: `change_log`, one row per field-level change (entity id, field name, hybrid logical clock, device id, value), idempotent on the change's own id so a repeated network retry never duplicates a record.

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
| `src/routes/transactions.ts` | `POST`/`GET /workspaces/:workspaceId/accounts/:accountId/transactions`, `PATCH .../:transactionId`; `POST /workspaces/:workspaceId/transfers` |
| `src/transactions/repository.ts` | Create, list, update a transaction and its splits (ADR 0005); `budgetDate` is derived at read time from the workspace's own time zone, never stored, so a later time zone change needs no reprocessing; a date-only `occurredAt` is anchored to midnight in the workspace's time zone instead of the database connection's own; reconciled transactions refuse further edits, and status can only ever reach `reconciled` through the dedicated reconciliation flow (#32), never a direct update; a transfer is two linked rows (`transferId`), each with a single null-category split holding the signed amount; rejects a transfer between two on-budget credit cards, matching `packages/core`'s own current limitation (#260); keeps the source format's own transaction id (`externalId`, e.g. OFX's FITID) when a confirmed import row carried one, for a later re-import's duplicate detection (#29); given a `QueueDriver`, `createTransaction`/`createTransfer` queue a `budget-recompute` job in the same transaction as the write, deduplicated per workspace and month (#35) |
| `src/routes/assignments.ts` | `POST /workspaces/:workspaceId/assignments` (a batch of ledger entries), `POST .../assignment-batches/:batchId/undo`, `POST .../assignments/:entryId/undo` |
| `src/assignments/repository.ts` | Append-only ledger (ADR 0008): insert a batch of entries sharing one `batch_id` (assign/unassign/move/quick assign), undo a whole batch or a single entry (reversing rows only, `reverses` unique so a row undoes at most once), and `listAssignmentTotals` — each category's assigned amount per month, derived from the ledger, the exact `Assignment[]` shape `packages/core`'s `computeBudgetMonth` takes |
| `src/routes/budget.ts` | `GET /workspaces/:workspaceId/budget-months/:month`, `GET .../budget-months/:month/problems` |
| `src/budget/repository.ts` | Wires accounts, transactions and the assignment ledger into `@envelope/core`'s `aggregateTransactions`/`computeBudgetMonth`, joining each category with its name, group and sort order; a card's starting-balance transaction (categorized to its own payment category) is excluded from aggregation, exactly as design.md's "Credit cards" specifies, and fed only into the card's own real balance (`CardBalance.owed`); `listBudgetProblems` derives the unresolved issues (overspent categories, uncovered card debt, unassigned money) from that same computation, storing nothing new |
| `src/routes/goals.ts` | `PUT`/`GET`/`DELETE /workspaces/:workspaceId/categories/:categoryId/goal`; `GET` takes a `month` query parameter and joins the goal with `@envelope/core`'s `computeTarget` (`asks`, `missing`, `progress`) |
| `src/goals/repository.ts` | One goal per category (`upsertGoal` replaces any existing one); `getGoalProgress` computes that category's carried/assigned/available via the budget month endpoint's own repository (#16) and feeds them to `computeTarget` |
| `src/routes/days-of-buffer.ts` | `GET /workspaces/:workspaceId/days-of-buffer`; an optional `asOf` query parameter, defaulting to today in the workspace's own time zone |
| `src/days-of-buffer/repository.ts` | Wires accounts and transaction history into `@envelope/core`'s `computeDaysOfBuffer` (#20) |
| `src/routes/quick-assign.ts` | `POST /workspaces/:workspaceId/quick-assign`: `month`, a `scope` (all categories or one group) and a `mode` (`fund_targets`, `cover_overspending`, `cover_card_debt`, `repeat_assigned`, `repeat_spent`) |
| `src/quick-assign/repository.ts` | Computes each in-scope category's desired amount for the chosen mode (targets via `computeTarget`, overspending and card debt via the budget month, last month's assigned/spent via the ledger and the budget month), then funds them in table order (group sort order, then category sort order) until unassigned money runs out, as one assignment batch (#15) |
| `src/routes/import.ts` | `PUT`/`GET /workspaces/:workspaceId/accounts/:accountId/import-mapping`; `POST .../import` (parses a file and stages its rows; `format: "csv"`, the default, uses the given or saved mapping; `format: "ofx"`/`"camt053"` need none; `format: "qif"` needs none either, but takes optional `dateFormat`/`decimalSeparator` hints for when `@envelope/core`'s heuristic can't tell them apart from the file alone); `GET .../staged-transactions`; `POST .../staged-transactions/confirm` (a batch of per-row decisions: category, income, or transfer to another account) |
| `src/import/repository.ts` | Saves/reads an account's CSV mapping; stages a parsed file's rows (`stageCsvImport`, `stageOfxImport`, `stageQifImport`, `stageCamt053Import`, #29, #30, #31), matching each against the account's existing transactions with `@envelope/core`'s `detectDuplicates` (#27) and comparing the file's closing balance, when given, with the account's projected balance; lists staged rows, sweeping any past the 7-day expiry first (design.md) — a lazy read-time sweep, since the queue module (0.1.5) does not exist yet; confirms a batch of decisions independently, one rejected row (an unsupported or same-account transfer, or a row given no category/transfer/income recognition) leaving that row staged for a retry instead of aborting the rest; a row matched to an existing transaction clears that transaction instead of creating a new one |
| `src/routes/reconciliation.ts` | `GET /workspaces/:workspaceId/accounts/:accountId/reconciliation-candidates?date=` (pending and cleared-tickable transactions up to that date, and the balance to build on); `POST .../reconciliations` (ticked transaction ids, a statement balance, and an optional adjustment); `POST /workspaces/:workspaceId/transactions/:transactionId/unlock-reconciliation` |
| `src/reconciliation/repository.ts` | Computes the cleared balance (the last non-broken reconciliation's own statement balance, plus the ticked cleared transactions) against the given statement balance; a zero difference reconciles them all in one row (`reconciliations`) and marks each transaction reconciled; a real difference either suggests a pending or unticked transaction whose amount matches exactly (closest date first), or, given an adjustment, creates one (`createTransaction`) and reconciles immediately; unlocking sets the transaction back to `cleared`, marks its reconciliation `broken_at`, and writes to the audit log (#216, #32) |
| `src/audit-log/repository.ts` | `recordAuditLog`: the only place that writes to `audit_log` (ADR 0005, #216), so every caller gets the same columns |
| `src/errors.ts` | `sendIfValidationError`: maps any `@envelope/core` `ValidationError`, thrown by the core itself or mirrored by a repository, to a 400 response with its stable `code` and `details` |
| `src/auth/token-verifier.ts` | Verifies a Keycloak access token's signature (against the realm's JWKS), issuer, audience and expiry; a Fastify preHandler that attaches the decoded claims to `request.auth` |
| `src/auth/user-mapper.ts` | Fastify preHandler, chained after the token verifier: upserts a `users` row from the token's `sub`/`email` claims and attaches its id to `request.userId` |
| `src/auth/workspace-membership.ts` | Fastify preHandler, chained after the user mapper: checks the local user's role in the workspace the request names, and opens the request's single database transaction with `app.user_id`/`app.workspace_id` set for ADR 0006's RLS policies; `registerWorkspaceScope` commits or rolls it back once the response is ready; `requireWriteAccess`, chained after it on every endpoint that changes budget data, rejects a `read_only` member with 403 (#24) |
| `src/users/repository.ts` | The `users` table's only entry point for queries (ADR 0005) |
| `src/queue/driver.ts` | The `QueueDriver` interface (design.md, "Queue module"): `enqueue` (data, run date, deduplication key, retry limit, optionally the caller's own transaction), `schedule` (a periodic job), `work` (registers a job type's handler, whose `JobHandler` also receives the job's own id, #40) |
| `src/queue/postgres-driver.ts` | The `postgres` adapter — the only file that imports `pg-boss`. Every queue it creates uses the `exclusive` policy, the one policy that actually rejects a repeat `deduplicationKey` (the default `standard` policy only stores the key, never enforces it); a transaction client given to `enqueue` becomes pg-boss's own `db` option, so the job insert commits or rolls back with it — pg-boss's job table doubling as the outbox (#34). `start()` also grants `envelope_app` `SELECT`/`INSERT` on `pgboss`'s tables, present and future (`ALTER DEFAULT PRIVILEGES`): it writes a job through its own connection, not `envelope_queue`'s, so the outbox trick needs that grant to work at all (#35). `work` opens its own transaction per delivery on `envelope_app`'s pool, sweeps `processed_jobs` rows past the 30-day retention, then inserts the job's id: a repeat delivery's insert hits the unique constraint, is rolled back, and the handler never runs, no exception escaping to pg-boss (#36) |
| `src/queue/index.ts` | `createQueueDriver(config, appPool)`: picks the adapter named by `QUEUE_DRIVER` — the only place that switches on it |
| `src/queue/job-types.ts` | Every job type's name and payload shape, and `ALL_JOB_TYPES` — the registry the double-delivery harness checks for coverage. Kept import-free so a producer (`transactions/repository.ts`) and a consumer (`notifications/budget-recompute-job.ts`, which imports `budget/repository.ts`, which imports the producer back) don't form a cycle |
| `src/queue/double-delivery.ts` | The shared double-delivery test harness (design.md; #37): `defineDoubleDeliveryCase` packages a job type's own fixture, handler and effect counter behind one non-generic shape so a mixed list of job types can share one array; `assertSingleDelivery` redelivers the same job id twice and asserts the counted effect happened once; `assertEveryJobTypeCovered` fails if `ALL_JOB_TYPES` has an entry with no case |
| `src/notifications/driver.ts` | The `PushDriver` interface (design.md, "Notifications"): `send(token, payload)`, `payload.notificationId` (the triggering job's id, #36) doubling as the platform's own coalescing key |
| `src/notifications/web-push-driver.ts` | The `web` adapter — the only file that imports `web-push`. Uses the job id (dashes stripped, 32 hex characters) as the Web Push `topic`, so a duplicate delivery replaces rather than duplicates a still-pending notification on the device (#39) |
| `src/notifications/unimplemented-driver.ts` | `ios`/`android` stubs: same `PushDriver` shape, reject with a clear message, until the mobile app (0.3.0) gives them a real device to send to |
| `src/notifications/repository.ts` | `sendPushToUser`: dispatches to every one of a user's registered devices (`device_tokens`), recording each as a `notification_deliveries` row; a device already marked `sent` for a given job is never delivered to again, so a retry resumes only from the still-pending ones |
| `src/notifications/index.ts` | `createPushDrivers(config)`: assembles the three platform drivers behind `PushDrivers` |
| `src/notifications/notified-problems.ts` | `reconcileNotifiedProblems`: compares a workspace/month's current budget problems against `notified_budget_problems`, returns only the new-or-changed ones, and overwrites that state to match (a resolved problem is deleted, so it counts as new again if it reappears) — find-then-write, not a DB unique constraint (a nullable `category_id`) (#40) |
| `src/notifications/budget-alert-text.ts` | `composeBudgetAlert`: renders a push notification's title/body for a set of budget problems, from a small, self-contained English/Italian lookup local to this package (no i18n catalog infrastructure exists yet; that's chosen in "phase 1"), picked by the recipient's own `language`, amounts formatted in their own `locale` (#40) |
| `src/notifications/budget-recompute-job.ts` | `createBudgetRecomputeHandler(drivers)`: the `budget-recompute` job's handler — recomputes a workspace/month's budget problems, reconciles them against the last-known state, and notifies every workspace member (regardless of role) whose problem is new or changed (#40) |
| `src/memberships/repository.ts` | `listWorkspaceMembers`: every member of a workspace regardless of role, with their own `language`/`locale`, for the budget-recompute job to notify (#40) |
| `src/sync/repository.ts` | `recordChange`/`getLatestChange`: the field-level change log (design.md, "Field-level change protocol"). `recordChange` is idempotent on the change's own id (`ON CONFLICT (id) DO NOTHING`) — a repeated network retry of the same change never creates a duplicate row (#42) |
| `src/test-helpers/keycloak.ts` | Provisions a throwaway Keycloak realm, clients and user for tests, through the admin REST API |
| `src/test-helpers/app-role.ts` | Grants `envelope_app` a test-only login (idempotently, cluster-wide) so tests can connect as the same restricted role the running server uses |
| `src/test-helpers/queue-role.ts` | Same as `app-role.ts`, for `envelope_queue` |
| `src/test-helpers/vapid-keys.ts` | A fixed, throwaway VAPID key pair so tests can start the server without a real one (#39/#40) |
| `src/app.ts` | `buildApp(config, queue?)`: assembles the Fastify instance and its routes, without opening a port (used directly by tests, which mostly omit `queue`); `queue`, when given, is threaded into the transactions routes so a write can enqueue a job in its own transaction (#35) |
| `src/main.ts` | Entry point: loads the config, creates and starts the queue driver (its own pool, separate from `buildApp`'s), registers the `budget-recompute` handler (#40), builds the app, starts listening; stops the app, the queue driver and its pool on shutdown |
| `*.test.ts` | Tests, next to the file they check |

## Commands

```bash
pnpm --filter @envelope/api dev          # start with auto-restart on file changes
pnpm --filter @envelope/api start        # start once
pnpm --filter @envelope/api migrate      # apply pending migrations
pnpm --filter @envelope/api test         # integration tests, then smoke tests, each in its own clearly separated node --test run
pnpm --filter @envelope/api test:integration   # only the integration tests
pnpm --filter @envelope/api test:smoke         # only the smoke tests (ADR 0007) — CI runs these as their own named step
pnpm --filter @envelope/api typecheck
```

## Configuration

Copy `.env.example` to `.env` and adjust it; `.env` is read automatically by `dev`/`start`/`migrate` and is ignored by Git.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — (required by `migrate`) | The migration runner's connection: needs DDL privileges, so it's the superuser (`envelope`) |
| `APP_DATABASE_URL` | — (required by `dev`/`start`) | The running server's own connection: `envelope_app`, restricted by Row-Level Security (ADR 0006) |
| `QUEUE_DRIVER` | `postgres` | Selects the queue adapter (design.md, "Queue module"); `postgres` (pg-boss) is the only one so far. Read by `loadQueueConfig`, a second, separate config loader (below) |
| `QUEUE_DATABASE_URL` | — (required by `dev`/`start`) | The queue module's own connection: `envelope_queue`, which pg-boss uses to manage its own schema (#34) |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | — (required by `dev`/`start`) | VAPID credentials for the `web` push adapter (#39), read by `loadPushConfig`, a third, separate config loader; required to start the server now that the `budget-recompute` job (#40) can send through it. Generate with `npx web-push generate-vapid-keys`. Self-hosting how-to: `#41` |
| `KEYCLOAK_ISSUER` | — (required) | The realm's issuer URL, e.g. `http://127.0.0.1:8080/realms/envelope`; also where the JWKS is fetched from |
| `KEYCLOAK_AUDIENCE` | — (required) | The client id every access token must be issued for |
| `HOST` | `127.0.0.1` | Address the server listens on |
| `PORT` | `3000` | Port the server listens on |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `LOG_PRETTY` | `false` | Human-readable logs instead of JSON; only for a terminal, never in production |
| `NODE_ENV` | `development` | |

A missing or invalid variable makes the process exit immediately with a clear error, instead of failing later somewhere unrelated. `DATABASE_URL` and `APP_DATABASE_URL` are two different connections on purpose (ADR 0006): the first can create tables, the second cannot even see another workspace's rows. `QUEUE_DRIVER`/`QUEUE_DATABASE_URL` are validated by their own loader, `loadQueueConfig` (`src/config.ts`), kept separate from `Config`/`loadConfig` so the many existing tests that build an app without a queue stay untouched (#34).

### Giving `envelope_app` (and `envelope_queue`) a login

Migrations create the `envelope_app` and `envelope_queue` roles but deliberately never give them `LOGIN` or a password (ADR 0006: that would mean committing a real credential to the repository). Do it once per Postgres instance, the same way `infra/.env` already holds the `envelope` and Keycloak passwords:

```bash
$ docker exec -it envelope-postgres-1 psql -U envelope -d envelope \
  -c "ALTER ROLE envelope_app WITH LOGIN PASSWORD '<a password you pick>';" \
  -c "ALTER ROLE envelope_queue WITH LOGIN PASSWORD '<a different password you pick>';"
```

Roles are shared by the whole Postgres instance (not per database), so this one command covers both the `envelope` and `envelope_test` databases. Use those passwords in `APP_DATABASE_URL` and `QUEUE_DATABASE_URL`.

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

Step 4 (Budget API) covers a full budget month driven through the API alone; scheduled transactions (`#22`, reserving money ahead of being recorded) moved to milestone 0.1.7 and are not here yet. Step 5 (Import) has CSV, OFX, QIF, CAMT.053 import and staging, and reconciliation; payee/category suggestion from the user's rules and history is out of scope for now (`#122`, a later phase). Step 6 (Queue and notifications) has the `QueueDriver` interface and its `postgres` adapter (`#34`), the outbox wired into the transaction-writing code path (`#35`), the idempotent `processed_jobs` register (`#36`), push notification delivery (`#39`) — `web` for real, `ios`/`android` deferred to milestone 0.3.0 — the `budget-recompute` job itself, notifying members only on a new or changed problem (`#40`), and the shared double-delivery test harness (`#37`). Scheduled transactions firing automatically (`#38`, itself waiting on `#22`, milestone 0.1.7) are not here yet. Step 7 (Sync) has only the change record model so far (`#42`): resolving a conflict by clock, the changes-since-clock endpoint, and the reconciled-transaction lock at the field-change layer are not here yet (`#43`, `#44`, `#45`). Not here yet either, its own later step of the roadmap: the web app itself (0.1.7 onward) — this package is the API only.
