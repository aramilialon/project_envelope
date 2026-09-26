-- Row-Level Security per workspace (design.md, "Isolation"; ADR 0006).
--
-- The application sets two session variables once it has authenticated the caller
-- and, for requests scoped to one workspace, checked their membership:
--   SELECT set_config('app.user_id', '<uuid>', true);
--   SELECT set_config('app.workspace_id', '<uuid>', true);
-- (the third argument makes the setting local to the current transaction.)
--
-- RLS is a second line of defense, not the only check: a bug in a query must still
-- not leak another workspace's rows even if the application-level check above is
-- missing or wrong.
--
-- PostgreSQL exempts superusers, and table owners unless FORCE ROW LEVEL SECURITY is
-- set, from every policy. `envelope_app` is the role every policy below is written
-- for. It has no LOGIN and no password yet: it exists so tests can exercise the
-- policies with `SET ROLE envelope_app` (which needs no password), ready to be
-- granted LOGIN and a password once the API needs its own restricted connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'envelope_app') THEN
    CREATE ROLE envelope_app NOSUPERUSER NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO envelope_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, workspaces, memberships, accounts, category_groups, categories,
  transactions, splits, monthly_assignments
TO envelope_app;

-- Once a session sets app.workspace_id with SET LOCAL for the first time, rolling
-- back that transaction resets it to '' (empty string), not to "unset": PostgreSQL
-- gives a custom GUC a reset value of '' the first time it is introduced in a
-- session, unless a session-level value was set before. nullif(..., '') turns that
-- (and a genuinely unset value, which current_setting(..., true) reports as NULL)
-- into NULL, so the comparisons below fail closed instead of raising a cast error.
CREATE FUNCTION app_workspace_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

CREATE FUNCTION app_user_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspaces
  USING (id = app_workspace_id())
  WITH CHECK (id = app_workspace_id());

-- A user must be able to find their own memberships before app.workspace_id is even
-- known (for example, to list "which workspaces am I in"), so this policy also
-- allows rows matching app.user_id, on top of the usual workspace match.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON memberships
  USING (user_id = app_user_id() OR workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON accounts
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE category_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON category_groups
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON categories
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON transactions
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE splits FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON splits
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE monthly_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON monthly_assignments
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());
