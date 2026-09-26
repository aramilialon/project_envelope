# Migrations

Plain SQL files, applied in order by `src/db/migrate.ts` — see [ADR 0005](../../../docs/adr/0005-plain-sql-and-node-postgres.md).

- Name every file `NNNN_short_description.sql`, for example `0001_workspaces.sql`.
- Never edit a file once it has been applied anywhere: the runner records its checksum and refuses to start if the checksum no longer matches. Add a new file instead.
- Apply pending migrations: `pnpm --filter @envelope/api migrate`.

This directory is empty for now: the domain schema (users, workspaces, accounts, transactions...) arrives in step 2 of the backend MVP (see `CLAUDE.md`).
