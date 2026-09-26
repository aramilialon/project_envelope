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

Not here yet: `goals` (targets) and every portfolio table (`instruments`, `trades`, `allocation_node`...), which belong to later steps of the roadmap.
