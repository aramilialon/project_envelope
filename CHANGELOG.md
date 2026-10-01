# Changelog

All notable changes to envelope are listed here, newest first. Versions follow semantic versioning: 1.0.0 marks the whole product (budget, portfolio, mobile and everything else in `docs/design.md`), so every 0.x.y release is still pre-1.0 by design, however usable a given 0.x.0 milestone group already is on its own. A new minor version (0.x.0) starts a milestone group (Budget, Portfolio, Mobile, ...); each patch release (0.x.y) closes one milestone within that group.

Each entry groups changes under **Added**, **Changed**, **Fixed** and **Removed**.

## [Unreleased]

### Added

- Docs: UX and visual design for the web app (`docs/ux/README.md`) — a screen inventory against the existing mockups, the navigation structure, a reusable component catalog, the accessibility baseline every mockup already follows, and the translation-key convention (ADR 0004) screens must use instead of literal text; a new sign-in mockup, the one screen design.md still listed as undesigned (`#70`).
- Docs: ADR 0009 — FormatJS chosen as the i18n library for the web app (and later the mobile app), over i18next and Lingui: its own message format is ICU MessageFormat, and its key + default-message idiom matches ADR 0004's stable-key lookup directly (`#47`).
- `apps/web`: the web app's own skeleton — a Vite + React installable PWA shell (`vite-plugin-pwa`), connected to `apps/api`'s `/health` endpoint as the one thing this bootstrap proves, no real screen yet beyond that placeholder (`#48`).
- `apps/api`: CORS (`@fastify/cors`), restricted to the web app's own origin (`WEB_ORIGIN`, defaulting to Vite's own dev server port) — needed for a browser to call the API at all (`#48`).
- `@envelope/core`: `computeBudgetMonth` reserves money for scheduled transactions not yet recorded — `BudgetInput.scheduledItems`, `CategoryMonth`/`BudgetMonth.reserved`. A category's `available` is net of it, but a reservation beyond what a category can cover is a warning, never overspending, and never carries over to the next month the way real overspending does (design.md, "Scheduled transactions") (`#250`).
- `apps/api`: scheduled transactions (rent, salary, subscriptions) — `scheduled_transactions`/`scheduled_transaction_splits`, and `POST`/`GET`/`PATCH`/`DELETE /workspaces/:workspaceId/scheduled-transactions`: account, payee/memo, next due date, recurrence, one split per category (a single split is "a category", several are a split template), enough to materialize a transaction later without asking again. Manually managed for now — automatic firing on the due date needs the queue module (`#38`, milestone 0.1.5). The budget month endpoint now surfaces each category's `reserved` money, fed by the requested month's own not-yet-recorded items (`#22`).
- `apps/web`: sign-in — Authorization Code + PKCE against the `envelope` Keycloak realm (`react-oidc-context`/`oidc-client-ts`), session handling and sign-out; `react-intl` (FormatJS, ADR 0009) wired in for the first time, `locale="en"` until `#62` adds the Italian catalog (`#49`).
- `scripts/keycloak/bootstrap.sh`: the `envelope-api` client now also sets `post.logout.redirect.uris` (needed for sign-out to work at all) (`#49`).

## [0.1.6] - 2026-09-30

### Added

- `@envelope/core`: a hybrid logical clock (HLC) — `nextHlc` ticks a device's own clock forward even if its wall clock disagrees with or runs behind a previous value, `compareHlc` gives any two changes a total, deterministic order, the basis for the sync protocol's "last write wins" (design.md, "Field-level change protocol") (`#42`).
- `apps/api`: `change_log`, one row per field-level change (entity id, field name, HLC, device id, value); `recordChange` is idempotent on the change's own id, so a repeated network retry never creates a duplicate row; `getLatestChange` reads the current winner for one entity's field (`#42`).
- `apps/api`: `POST /workspaces/:workspaceId/changes` applies a device's own queued field changes, converging to the change with the later clock regardless of arrival order, through an explicit allowlist of supported fields (`transactions.memo`/`transactions.payee` for now) rather than building `UPDATE` SQL from the device-supplied field name directly (`#43`).
- `apps/api`: two offline devices independently undoing the same assignment-ledger row no longer surfaces as a raw error on the one that syncs second — recognized as "already undone by the other device" and dropped silently, the same outcome as undoing an already-undone row through the existing API (`#43`).
- `apps/api`: `GET /workspaces/:workspaceId/changes` — the download side of the sync protocol: every field-level change later than the clock a device last saw, or all of them for a first sync, ordered the same way `compareHlc` would; a read-only member can call it, unlike the upload side (`#44`).
- `apps/api`: an incoming field-level change to a reconciled transaction is now rejected outright (`"locked"`), design.md's "the server rejects later changes" — checked before clock resolution even runs, and never recorded, so a retry after the transaction unlocks (`#32`) is unaffected by the rejected attempt (`#45`).
- `apps/api`: 0.1.6's checkpoint smoke test against the real process (ADR 0007) — two simulated devices, each with its own HLC and offline queue, make offline edits including a genuine conflict on the same field; syncing converges both to the same result, the later clock wins the conflict, neither device's own non-conflicting edit is lost, and a resent change never creates a duplicate `change_log` row (`#46`).

## [0.1.5] - 2026-09-30

### Added

- `apps/api`: the queue module's `QueueDriver` interface (`enqueue`, `schedule`, `work`) and its `postgres` adapter (pg-boss), the only file allowed to import it (design.md, "Queue module"). Every queue it creates uses the `exclusive` policy, so a repeat `deduplicationKey` is rejected instead of merely recorded; `enqueue` accepts the caller's own transaction client, so the job commits or rolls back with the data that triggered it, pg-boss's own job table doubling as the outbox. A new `envelope_queue` role (its own migration) gives pg-boss the schema-management privilege `envelope_app` deliberately does not have, without widening the running server's own connection (`#34`).
- `apps/api`: the queue module wired into `main.ts`, and into `createTransaction`/`createTransfer` — creating a transaction or a transfer now queues a `budget-recompute` job in the same database transaction, deduplicated per workspace and month; a job written inside a transaction that later rolls back is never delivered. `envelope_app` is granted `SELECT`/`INSERT` on pg-boss's own tables, present and future, so it can write that job through its own connection without the `CREATE` privilege only `envelope_queue` holds (`#35`).
- `apps/api`: `processed_jobs`, so every job delivery is idempotent without the job author having to check it — `work` opens its own transaction, sweeps rows past the 30-day retention, inserts the job's id, then runs the handler; a repeat delivery's insert hits the unique constraint, is rolled back, and the handler never runs (`#36`).
- `apps/api`: push notification delivery — a `PushDriver` interface, a real `web` adapter (Web Push, VAPID), and `ios`/`android` stubs deferred to the mobile app (`0.3.0`). A device's own token lives in `device_tokens`, scoped by user rather than workspace; `sendPushToUser` sends to every one of a user's devices, recording each as a `notification_deliveries` row and resuming only from the still-pending ones on a retry. The triggering job's id doubles as the Web Push `topic`, so a duplicate delivery replaces rather than duplicates a still-pending notification on the device (`#39`).
- `apps/api`: the `budget-recompute` job now actually runs — the first real `work()` handler registered in the codebase. It recomputes a workspace/month's budget problems (a negative category, a purchase exceeding the available balance, money to assign) and notifies every workspace member, regardless of role, only when a problem is new or its amount has changed since the last time (`notified_budget_problems`), not every time the job happens to run while it persists unchanged. Notification text is a small, self-contained English/Italian lookup local to `apps/api` (no catalog infrastructure exists yet; the i18n library is chosen in phase 1), picked by the recipient's own `language`, with amounts formatted in their own `locale` (`#40`).
- `apps/api`: the shared double-delivery test harness (design.md, "Queue module") — every registered job type must prove that redelivering the same job id produces its effects exactly once; a job type with no case fails the harness's own coverage check (`#37`).
- Docs: a how-to guide for self-hosting push notifications — generating a VAPID key pair for the `web` adapter, and why `ios`/`android` have nothing to configure yet (`#41`).

### Changed

- `apps/api`: `JobHandler` now also receives the job's own id, alongside its data and transaction client, so a handler can use it as its own idempotency key for an external effect (`#40`).

### Fixed

- `apps/api`: a request's transaction committed in an `onResponse` hook, which runs *after* the response has already been sent to the client — a write's own response could be observed before its transaction had actually committed, or, on a crash in that narrow window, before it ever would. Moved to `onSend`, which runs before the response is flushed, so a response is only ever seen once its own transaction has genuinely committed (`#294`).

## [0.1.4] - 2026-09-30

### Added

- `@envelope/core`: `daysBetween` (promoted from a private helper in `computeDaysOfBuffer`) and `detectDuplicates` — matches an import's rows against an account's existing transactions, by the bank's own transaction id or otherwise the same amount within a 3-day window, each existing transaction matched at most once (`#27`).
- `@envelope/core`: `parseCsv` — parses a mapped CSV file's rows (one amount column or separate outflow/inflow columns, three date formats, either decimal separator, an optional header row and memo column) (`#28`).
- `apps/api`: CSV import — a column mapping remembered per account (`PUT`/`GET .../import-mapping`); `POST .../import` parses a file and stages its rows, matching duplicates against the account's existing transactions and comparing the file's closing balance, when given, with the account's projected balance; `GET .../staged-transactions` lists them, sweeping any past the 7-day expiry; `POST .../staged-transactions/confirm` confirms a batch of per-row decisions (category, income, or transfer to another account) into real transactions, clearing a matched existing transaction instead of duplicating it (`#28`).
- `@envelope/core`: `parseOfx` — parses an OFX statement download's transactions into the same normalized shape the CSV importer produces, no column mapping needed; reads both OFX 1.x's SGML and OFX 2.x's XML the same way (`#29`).
- `apps/api`: `POST .../import` accepts `format: "ofx"`, staging an OFX file's transactions the same way as CSV; a confirmed transaction keeps the bank's own transaction id (OFX's FITID), so a later re-import of the same statement matches it precisely instead of only by amount and date (`#29`).
- `@envelope/core`: `parseQif` — parses a QIF file's transactions, no column mapping needed; unlike OFX, QIF's date order and decimal separator are not standardized, so both are inferred from the file's own data first, falling back to an "ambiguous_date_format"/"ambiguous_decimal_separator" `ValidationError` asking for an explicit hint only when the file gives no evidence either way (`#30`).
- `apps/api`: `POST .../import` accepts `format: "qif"`, with optional `dateFormat`/`decimalSeparator` hints for an ambiguous file (`#30`).
- `@envelope/core`: `parseCamt053` — parses an ISO 20022 CAMT.053 statement's entries, no column mapping and no date/decimal ambiguity (ISO 20022 fixes both, unlike OFX's date order and QIF's date order and decimal separator); the counterparty name and remittance info come from the entry's first transaction detail, when the bank includes one (`#31`).
- `apps/api`: `POST .../import` accepts `format: "camt053"` (`#31`).
- `apps/api`: reconciliation — `GET /workspaces/:workspaceId/accounts/:accountId/reconciliation-candidates` lists pending and tickable cleared transactions up to a date; `POST .../reconciliations` compares the ticked total (plus the last reconciliation's own balance) against a statement balance, either completing the reconciliation on a zero difference, suggesting a pending or unticked transaction that exactly explains a real one, or resolving it with an adjustment transaction given in the same call; `POST /workspaces/:workspaceId/transactions/:transactionId/unlock-reconciliation` reopens a reconciled transaction, an audited action (`#216`) that marks its reconciliation broken until redone. A transaction's status can now only reach `reconciled` through this flow, never a direct update (`#32`).
- `apps/api`: 0.1.4's checkpoint smoke test against the real process (ADR 0007) — re-importing the exact same CSV or OFX file a second time creates no duplicate transactions, every row instead recognized as a duplicate of the one the first import already created; a negative case confirms a genuinely different, unrelated import is not mistaken for one (`#33`).

### Fixed

- `apps/api`: a staged transaction's date came back a calendar day early whenever the server process ran outside UTC, since `node-postgres` reads a plain `date` column at midnight in its own time zone; now read as text (`to_char`) like every other date in the codebase (`#278`).

## [0.1.3] - 2026-09-29

### Added

- `@envelope/core`: `computeBudgetMonth` takes each on-budget credit card's real balance and returns `uncovered` per payment category — debt not yet covered by assigned money, derived fresh every call instead of being swept to zero at month-end or silently lost (`#249`).
- `apps/api`: accounts — create (with an on-budget credit card's payment category and optional starting balance transaction created automatically), list, close (`#11`).
- `apps/api`: category groups and categories — create, list, archive, reorder (`#12`).
- `apps/api`: transactions — create, list, update, with splits, income (a `null` category) and a reconciled transaction refusing further edits; `budgetDate` is derived at read time from the workspace's own time zone rather than stored (`#13`).
- `apps/api`: transfers between accounts, as two linked transactions (`transferId`), created atomically; a transfer between two on-budget credit cards is rejected, matching `packages/core`'s own current limitation (`#14`).
- `apps/api`: the assignment ledger (ADR 0008) — assign, unassign and move money as a batch of append-only entries sharing one `batch_id`; undo a whole batch or a single entry, as new reversing rows, never an edit; a category's assigned amount per month is derived from the ledger, never stored (`#15`).
- `apps/api`: the budget month endpoint (`GET /workspaces/:workspaceId/budget-months/:month`), wiring accounts, transactions and the assignment ledger into `@envelope/core`'s `computeBudgetMonth`, joined with each category's name, group and sort order (`#16`).
- `@envelope/core`: `computeTarget` for the four target kinds (monthly amount, amount by a date, repeating expense, balance to keep) — what each asks this month, what is still missing, and progress (`#17`).
- `apps/api`: goals (targets) — one per category, set/read/deleted; reading joins the goal with how much it still needs this month, via `@envelope/core`'s `computeTarget` (`#18`).
- `@envelope/core`: `computeDaysOfBuffer` — the amount-weighted average number of days between a euro coming in and being spent, first in first out, across every on-budget account, over the outflows of the last 30 days; a transfer between two on-budget accounts does not count (`#20`).
- `apps/api`: the days of buffer endpoint (`GET /workspaces/:workspaceId/days-of-buffer`), recomputed from real transactions, defaulting to today in the workspace's own time zone (`#21`).
- `apps/api`: unresolved budget problems (`GET /workspaces/:workspaceId/budget-months/:month/problems`) — overspent categories, uncovered card debt and unassigned money still to assign, derived entirely from the budget month computation, nothing new stored (`#23`).
- `@envelope/core`: `previousMonth`, the complement of `nextMonth` (`#19`).
- `apps/api`: quick assign (`POST /workspaces/:workspaceId/quick-assign`) — fund the targets, cover overspending, cover the cards' debt, repeat last month's assigned or spent amounts, each scoped to all categories or one group, as one assignment-ledger batch; categories are funded in table order until unassigned money runs out (`#19`).
- `apps/api`: every endpoint that changes budget data now rejects a `read_only` member with 403 (`requireWriteAccess`, chained after workspace membership); `owner` and `editor` are unaffected, and a `read_only` member can still read everything (`#24`).
- `apps/api`: 0.1.3's checkpoint smoke test against the real process, randomized rather than scripted (ADR 0007) — a positive scenario (including quick assign) whose expected budget invariant is computed independently from the same randomly generated data, and a negative scenario covering every rejection this milestone added, including a `read_only` member's; the 0.1.0 and 0.1.2 smoke tests get the same positive/negative discipline (`#25`).

### Fixed

- `apps/api`: a date-only `occurredAt` was anchored to the database connection's own time zone instead of the workspace's, producing the wrong `budgetDate` for a workspace west of Greenwich; also affected `accounts.createdAt`/`closedAt`, returned as a `Date` object instead of the declared `string` by every repository reading a `timestamptz` column (`#13`).
- `apps/api`: a transaction split naming a category that does not exist in the workspace hit the database's own foreign-key constraint instead of a clean `400`, found while writing #25's randomized negative smoke test (`#25`).

### Changed

- CI: the single `pnpm test` step is now one named step per package and test kind (`packages/core` unit, `apps/api` integration, `apps/api` smoke), so the job summary itself says where a failure is; each step runs even if an earlier one failed, and a final step fails the job if any of them did not succeed. `apps/api`'s `test` script splits into `test:integration` and `test:smoke`, still chained together locally (`#258`).
- Documentation: the assignment ledger (ADR 0008) gets a device-generated `batch_id`, shared by every entry one user action creates (quick assign, undoing a group), so a whole batch undoes together without a separate batch table; the budget month's reconciliation sentence now distinguishes `creditOverspending` (the invariant's transient term) from `uncovered` (cumulative, includes starting balances).
- Documentation: the budget month mockup now covers assigning and moving money through the assignment ledger (editing the assigned amount in the table, one Assign / Move money form, quick assign, the month's assignments with undo), scheduled transactions that reserve money (reserved amounts, shortfall warnings, recording and skipping, a preview of next month, creating a scheduled transaction) and card debt ("to cover" on payment categories, a card added with a starting balance); `docs/design.md` describes these screens, and its credit card rules now keep the starting balance out of the payment category's activity.
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
