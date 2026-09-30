# Migrations

Plain SQL files, applied in order by `src/db/migrate.ts` — see [ADR 0005](../../../docs/adr/0005-plain-sql-and-node-postgres.md).

- Name every file `NNNN_short_description.sql`, for example `0001_workspaces.sql`.
- Never edit a file once it has been applied anywhere: the runner records its checksum and refuses to start if the checksum no longer matches. Add a new file instead.
- Apply pending migrations: `pnpm --filter @envelope/api migrate`.

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

Not here yet: every portfolio table (`instruments`, `trades`, `allocation_node`...), which belongs to a later step of the roadmap.
