# 0006 — Row-Level Security with session variables, enforced against a dedicated role

- **Status:** accepted
- **Date:** 2026-09-26

## Context

Every workspace-scoped table must be isolated per workspace (design.md, "Isolation"): a bug in a query must never expose another workspace's data, even if the application-level membership check that normally runs first has a bug or is missing.

PostgreSQL's Row-Level Security (RLS) is built for exactly this, but it only restricts roles that are neither superusers nor (unless `FORCE ROW LEVEL SECURITY` is set) the table's owner. The role the `docker-compose` PostgreSQL image bootstraps (`envelope`, from `POSTGRES_USER`) is a superuser, and it is also the role that runs migrations and therefore owns every table.

## Decision

- **Every workspace-scoped table** (`workspaces`, `memberships`, `accounts`, `category_groups`, `categories`, `transactions`, `splits`, `monthly_assignments`) carries its own `workspace_id` column, even where it could be derived through a join (for example `splits.workspace_id` duplicates `splits.transaction_id -> transactions.workspace_id`). This keeps every policy a simple, fast column comparison, with no subquery.
- **Two session variables**, set by the application once per request after checking the Keycloak token and the caller's membership:
  - `app.user_id`: the authenticated user.
  - `app.workspace_id`: the workspace the request operates on, once known.

  Read through the `app_workspace_id()` / `app_user_id()` SQL functions, not `current_setting(...)` directly: PostgreSQL gives a custom GUC like `app.workspace_id` a reset value of `''` (empty string), not "unset", the first time a session sets it with `SET LOCAL` and then commits or rolls back that transaction — only a GUC that has *never* been set in the session returns `NULL` from `current_setting(name, true)`. The two functions apply `nullif(..., '')` before the cast to `uuid`, so both cases fail closed (no row matches) instead of the second one raising `invalid input syntax for type uuid: ""`. Set with `SELECT set_config('app.workspace_id', $1, true)`, the parameterized form of `SET LOCAL`, since `SET` itself does not accept query parameters.
- **`ALTER TABLE ... FORCE ROW LEVEL SECURITY`** on every one of those tables, so the policies apply even to a connection that happens to own the tables.
- **A dedicated `envelope_app` role**, created without `LOGIN`, that every policy is written for. Migrations grant it exactly the privileges the application will need (`SELECT, INSERT, UPDATE, DELETE` on the tables above), nothing more. Migrations never give it a password; it gets `LOGIN` and a password out of band, once per PostgreSQL instance (docs/getting-started.md), and it is the role the API connects as.
- **`memberships` gets an additional clause**: a row is visible if `user_id` matches `app.user_id`, even when `app.workspace_id` does not match. Otherwise a user could never discover which workspaces they belong to before a workspace is already selected — a chicken-and-egg problem this rule avoids.
- **Foreign keys between workspace-scoped tables are composite** (added by migration 0029, #504; see "Foreign keys bypass Row-Level Security" below).
- **`users` has no RLS.** It holds identity and preferences mirrored from Keycloak, not workspace data; every real exposure risk is already bounded by the join through `memberships`.

## Foreign keys bypass Row-Level Security

PostgreSQL checks a foreign key as the owner of the referenced table, and Row-Level Security does not apply to that check. A plain `account_id REFERENCES accounts (id)` therefore lets a row in workspace A reference workspace B's account once its id is known: the policies hide B's rows from every read and write `envelope_app` makes, but not from the foreign key, so the insert succeeds.

So every foreign key from one workspace-scoped table to another includes `workspace_id`:

- The referenced table has `UNIQUE (workspace_id, id)`, named `<table>_workspace_id_id_key`.
- The reference is `FOREIGN KEY (workspace_id, x_id) REFERENCES x (workspace_id, id)`: the referenced row must belong to the same workspace as the referencing one, which the policies already force to be the selected workspace.
- A nullable reference keeps the default `MATCH SIMPLE`, so a null id skips the check as before. This is only safe because `workspace_id` is `NOT NULL` on every workspace-scoped table: with `MATCH SIMPLE`, a null `workspace_id` would skip the composite check entirely.
- `ON DELETE SET NULL` names its column (`ON DELETE SET NULL (x_id)`), so deleting the referenced row clears only the id and never the `NOT NULL` `workspace_id` beside it.

References to `workspaces` itself and to `users` (global, not workspace data) stay single-column. `src/db/schema.test.ts` checks the catalog: every foreign key whose two tables both have a `workspace_id` column must pair them. `transactions.transfer_id` therefore pairs two transactions of the same workspace only; the link between two workspaces' transactions (design.md, "Workspaces and transfers between them") will need a design of its own.

A migration that checks or validates existing data (the guard in 0029, and the validation `ADD CONSTRAINT` performs) only sees the rows the migrating role can see. Under `FORCE ROW LEVEL SECURITY`, a role that is neither superuser nor `BYPASSRLS` sees none, so 0029 sets `row_security = off` for its own transaction: a role that cannot bypass RLS then gets an error instead of silently validating nothing. Any future migration that reads or validates workspace data must do the same.

## Why migrations never give `envelope_app` a password

Giving it `LOGIN` now would mean either committing a password to the repository (forbidden, and pointless: anyone with the repository would have it) or extending the plain-SQL migration runner to read secrets from the environment, which ADR 0005 deliberately keeps simple. Instead, tests exercise the real policies today with `SET ROLE envelope_app`, which needs no password because it is a role change within an already-authenticated superuser session, not a new login. `LOGIN` and a real password are given out of band (the same way `infra/.env` already handles the `envelope` and Keycloak passwords), as docs/getting-started.md describes; the API connects as `envelope_app`.

## Discarded alternatives

- **Checking the workspace in application code only:** simpler, but a single missing `WHERE workspace_id = ...` in a repository query would leak data across workspaces, exactly what design.md rules out.
- **A separate PostgreSQL database per workspace:** perfect isolation, but rules out cross-workspace queries the product will eventually want (for example linked transfers between workspaces, design.md "Workspaces and transfers between them") and does not fit a multi-tenant SaaS-style deployment.

## Consequences

- Every future migration that adds a workspace-scoped table must also add its `workspace_id` column, its policy, a grant to `envelope_app`, and composite foreign keys to the other workspace-scoped tables it references. `src/db/schema.test.ts` enforces the policy and the composite keys: it derives the list of workspace-scoped tables from every table with a `workspace_id` column, instead of a list kept by hand.
- RLS is in effect for the running API, which connects as `envelope_app`; the migration runner still connects as the owner `envelope`, which is why data-checking migrations turn `row_security` off explicitly.
