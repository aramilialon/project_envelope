-- A category's target (design.md, "Target calculation"; packages/core's
-- computeTarget takes exactly this shape). One goal per category: setting a
-- new one replaces the old, it is not a history.
CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  category_id uuid NOT NULL UNIQUE REFERENCES categories (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('monthly', 'by_date', 'repeating', 'balance')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  due_month date CHECK (due_month IS NULL OR due_month = date_trunc('month', due_month)::date),
  every_months integer CHECK (every_months IS NULL OR every_months IN (2, 3, 4, 6, 12, 24)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Matches packages/core's Target union exactly: due_month/every_months are
  -- required or forbidden together depending on kind.
  CHECK (
    (kind = 'monthly' AND due_month IS NULL AND every_months IS NULL) OR
    (kind = 'by_date' AND due_month IS NOT NULL AND every_months IS NULL) OR
    (kind = 'repeating' AND due_month IS NOT NULL AND every_months IS NOT NULL) OR
    (kind = 'balance' AND due_month IS NULL AND every_months IS NULL)
  )
);

CREATE INDEX goals_workspace_id_idx ON goals (workspace_id);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON goals
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON goals TO envelope_app;
