# Migrations

Plain SQL files, applied in order by `src/db/migrate.ts` — see [ADR 0005](../../../docs/adr/0005-plain-sql-and-node-postgres.md).

- Name every file `NNNN_short_description.sql`, for example `0001_workspaces.sql`.
- Never edit a file once it has been applied anywhere: the runner records its checksum and refuses to start if the checksum no longer matches. Add a new file instead.
- Apply pending migrations: `pnpm --filter @envelope/api migrate`.
- A new workspace-scoped table carries its own `workspace_id`, Row-Level Security and a grant to `envelope_app` (ADR 0006). If other tables will reference it, give it `UNIQUE (workspace_id, id)`; every foreign key to another workspace-scoped table is composite, `FOREIGN KEY (workspace_id, x_id) REFERENCES x (workspace_id, id)`, because PostgreSQL checks foreign keys without Row-Level Security (ADR 0006, "Foreign keys bypass Row-Level Security"). A nullable reference keeps the default `MATCH SIMPLE`; `ON DELETE SET NULL` names its column, `ON DELETE SET NULL (x_id)`, so it never clears `workspace_id`. `src/db/schema.test.ts` fails if either rule is missed.

## Contents

| File | What it creates |
| --- | --- |
| `0001_workspaces.sql` | `workspaces` |
| `0002_users.sql` | `users` (identity mirrored from Keycloak, plus language/locale/time zone) |
| `0003_memberships.sql` | `memberships` (user × workspace × role) |
| `0004_accounts.sql` | `accounts` |
| `0005_categories.sql` | `category_groups`, `categories` |
| `0006_transactions.sql` | `transactions`, `splits` |
| `0007_monthly_assignments.sql` | `monthly_assignments` |
| `0008_workspace_row_level_security.sql` | Row-Level Security policies and the `envelope_app` role (see [ADR 0006](../../../docs/adr/0006-row-level-security.md)) |
| `0009_audit_log.sql` | `audit_log` (append-only: no `UPDATE`/`DELETE` grant to `envelope_app`) |
| `0010_accounts_payment_category.sql` | `accounts`: drops `'off_budget'` from `type` (on-budget is `on_budget` alone), adds `payment_category_id` |
| `0011_assignment_ledger.sql` | Drops `monthly_assignments` (migration 0007), creates `assignment_ledger` — an append-only ledger, no `UPDATE`/`DELETE` grant to `envelope_app` (see [ADR 0008](../../../docs/adr/0008-assignment-ledger.md)) |
| `0012_goals.sql` | `goals` — one target per category, shaped exactly like `@envelope/core`'s `Target` union (a `CHECK` constraint ties `due_month`/`every_months` to `kind`) |
| `0013_import_staging.sql` | `import_mappings` (a CSV column mapping per account), `staged_transactions` (no `UPDATE` grant: confirmed away or expired, never edited in place) |
| `0014_transaction_external_id.sql` | `transactions`: adds `external_id` (the source format's own transaction id, e.g. OFX's FITID, kept from a confirmed import for a later re-import's duplicate detection) |
| `0015_reconciliation.sql` | `reconciliations` (one row per completed reconciliation, `broken_at` set when a transaction it reconciled is unlocked), `transactions.reconciliation_id` |
| `0016_queue_role.sql` | The `envelope_queue` role (#34) — pg-boss's own connection, granted `CREATE` on the database so it can manage its own `pgboss` schema, which cannot be captured as a fixed migration (dynamic per-queue DDL) |
| `0017_processed_jobs.sql` | `processed_jobs` (#36) — no Row-Level Security (a job id is not a workspace concept); `envelope_app` gets `SELECT`/`INSERT`/`DELETE`, the last one for sweeping rows past the 30-day retention |
| `0018_push_notifications.sql` | `device_tokens` (#39) — scoped by `app_user_id()`, not a workspace: a user's own devices, shared across every workspace they belong to; `notification_deliveries`, one row per (job, device), reached only through `device_tokens` so it needs no `app_user_id()` policy of its own |
| `0019_notified_budget_problems.sql` | `notified_budget_problems` (#40) — a workspace/month's last-known budget problems, so the `budget-recompute` job notifies only on a new or changed one; no unique constraint (a nullable `category_id`), reconciled application-side instead |
| `0020_change_log.sql` | `change_log` (#42) — one row per field-level change (design.md, "Field-level change protocol"): entity id, field name, HLC (hybrid logical clock), device id, value. `id` has no default: it is generated on the device, and is the idempotency key a repeated network retry relies on |
| `0021_scheduled_transactions.sql` | `scheduled_transactions`, `scheduled_transaction_splits` (#22) — account, payee/memo, next due date, recurrence (`recur_every`/`recur_unit`), and one split per category (a single split is "a category", several are a split template); a split's `amount_cents` is always positive, unlike an ordinary split's signed amount. No "recorded" state yet: materialization is a separate, later issue (0.1.5 Queue and notifications) |
| `0022_workspace_membership_listing.sql` | `workspaces`' own Row-Level Security policy (migration 0008) gains the membership-based read allowance `memberships` already had, so a user can list every workspace they belong to (#50) with only `app.user_id` set — `app.workspace_id` is never known before one is picked. Read-only: `WITH CHECK` (insert/update) is untouched |
| `0023_system_job_workspace_listing.sql` | `app_is_system_job()` and a third `workspaces` read allowance for it (ADR 0010, #38) — a periodic job with no request of its own (so neither `app.user_id` nor `app.workspace_id` is ever set) can still enumerate every workspace, gated by a session variable only that one job's own handler sets. Read-only, same as 0022 |
| `0024_scheduled_income.sql` | `scheduled_transaction_splits.category_id` becomes nullable (#347) — a scheduled transaction's single split can now be income (no category), mirroring an ordinary transaction's own null-category convention (migration 0006); application code still rejects a null category mixed into a multi-split template |
| `0025_brokerage_account_type.sql` | `accounts`: adds `'brokerage'` to `accounts_type_check` (#74), and `accounts_brokerage_off_budget_check` — a brokerage account is always off budget (`type <> 'brokerage' OR on_budget = false`). No data migration |
| `0026_instruments.sql` | `instruments` (#76) — the shared catalog, one row per listing: no `workspace_id` and no Row-Level Security (the same reasoning as `users`). Every row needs an ISIN, or a ticker and an exchange; unique per (ISIN, exchange) and per (ticker, exchange), ISIN, ticker and exchange stored upper-cased; `type` is one of `stock`, `fund` (ETFs included), `etc_etn`, `government_bond`, `bond`, `certificate`, `cash`, `other`; `price_factor_e6` (`bigint`, the factor scaled by 10^6, default 1000000) for prices quoted in percent of nominal or in pence. `created_by` is recorded but never returned by the API. Append-only for `envelope_app`: `SELECT`/`INSERT` only, no `UPDATE`/`DELETE` |
| `0027_portfolios.sql` | `portfolios` (#75) — name, free-text purpose, `archived_at`; `UNIQUE (workspace_id, id)` so a later table (`trades`, #77) can reference a portfolio with a composite foreign key that cannot cross workspaces; a partial unique index on `(workspace_id, lower(btrim(name))) WHERE archived_at IS NULL` backs the application's own `name_taken` check against a concurrent request. No accounts join table: the accounts a portfolio spans are derived from its trades |
| `0029_composite_workspace_foreign_keys.sql` | `UNIQUE (workspace_id, id)` (`<table>_workspace_id_id_key`) on every referenced workspace table, and every foreign key between two workspace-scoped tables becomes composite on `workspace_id`, keeping its name and `ON DELETE` behaviour (#504), so a row can no longer reference another workspace's row whose id it knows. Refuses to run, naming every offending column, if existing rows already cross workspaces. |

Not here yet: the other portfolio tables (`prices`, `trades`, `allocation_nodes`...), each added by its own issue of the portfolio milestones.
