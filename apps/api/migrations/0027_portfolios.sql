-- A portfolio (design.md, "Portfolio module" and "Data model"; #75): a named group of holdings with its own purpose,
-- free text with no fixed list of values. It declares no accounts of its own: every trade is
-- assigned to exactly one portfolio at entry (#77), so which accounts a portfolio spans is a
-- query over its trades, never a stored relationship (no join table).
CREATE TABLE portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Lets a later table (trades, #77) reference a portfolio with a composite foreign key
  -- (workspace_id, portfolio_id), so a row can never point at another workspace's portfolio.
  UNIQUE (workspace_id, id)
);

CREATE INDEX portfolios_workspace_id_idx ON portfolios (workspace_id);

-- Two non-archived portfolios of one workspace never share a name, ignoring case and
-- surrounding spaces (the same rule category groups and categories follow, #397). The
-- application checks first and answers 409 `name_taken`; this index only closes the race
-- between two concurrent requests. An archived portfolio does not block reusing its name.
CREATE UNIQUE INDEX portfolios_active_name_idx ON portfolios (workspace_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON portfolios
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON portfolios TO envelope_app;
