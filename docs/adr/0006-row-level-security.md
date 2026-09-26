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
- **A dedicated `envelope_app` role**, created without `LOGIN`, that every policy is written for. Migrations grant it exactly the privileges the application will need (`SELECT, INSERT, UPDATE, DELETE` on the tables above), nothing more. It has no password yet and is not what the API connects as today.
- **`memberships` gets an additional clause**: a row is visible if `user_id` matches `app.user_id`, even when `app.workspace_id` does not match. Otherwise a user could never discover which workspaces they belong to before a workspace is already selected — a chicken-and-egg problem this rule avoids.
- **`users` has no RLS.** It holds identity and preferences mirrored from Keycloak, not workspace data; every real exposure risk is already bounded by the join through `memberships`.

## Why `envelope_app` has no password yet

Giving it `LOGIN` now would mean either committing a password to the repository (forbidden, and pointless: anyone with the repository would have it) or extending the plain-SQL migration runner to read secrets from the environment, which ADR 0005 deliberately keeps simple. Instead, tests exercise the real policies today with `SET ROLE envelope_app`, which needs no password because it is a role change within an already-authenticated superuser session, not a new login. `LOGIN` and a real password are added later, out of band (the same way `infra/.env` already handles the `envelope` and Keycloak passwords), once the API's own connection needs to use this role instead of `envelope` (phase 3 of the backend MVP, authentication, or when the budget API in phase 4 starts issuing real queries).

## Discarded alternatives

- **Checking the workspace in application code only:** simpler, but a single missing `WHERE workspace_id = ...` in a repository query would leak data across workspaces, exactly what design.md rules out.
- **A separate PostgreSQL database per workspace:** perfect isolation, but rules out cross-workspace queries the product will eventually want (for example linked transfers between workspaces, design.md "Workspaces and transfers between them") and does not fit a multi-tenant SaaS-style deployment.

## Consequences

- Every future migration that adds a workspace-scoped table must also add its `workspace_id` column, its policy, and a grant to `envelope_app`; nothing enforces this automatically yet.
- Until `envelope_app` gets `LOGIN`, RLS is proven correct by tests but not yet in effect for the running API, which still connects as the superuser `envelope`. This is a known, temporary gap, not an oversight: closing it is part of wiring up the API's real database connection in a later step.
