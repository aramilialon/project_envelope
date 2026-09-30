-- Tracks each workspace/month's last-known budget problems (#40), so the
-- budget-recompute job (design.md, "Notifications") notifies members only
-- when a problem is new or its amount has changed, not every time the job
-- runs while it persists unchanged.
--
-- No unique constraint on (workspace_id, month, kind, category_id): category_id
-- is NULL for "unassigned_money" (not about any one category), and a plain
-- unique index never treats two NULLs as a conflict, so it would not stop
-- duplicate rows from appearing anyway. The application reconciles this table
-- with a find-then-write instead (apps/api/src/notifications/notified-problems.ts),
-- the same tradeoff accounts/repository.ts's findOrCreatePaymentCategoryGroup
-- already accepts, given a workspace has at most one budget-recompute job
-- pending at a time (the "exclusive" queue policy, #34).
CREATE TABLE notified_budget_problems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  kind text NOT NULL CHECK (kind IN ('overspent_category', 'uncovered_card_debt', 'unassigned_money')),
  category_id uuid REFERENCES categories (id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notified_budget_problems_workspace_month_idx ON notified_budget_problems (workspace_id, month);

ALTER TABLE notified_budget_problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE notified_budget_problems FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON notified_budget_problems
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notified_budget_problems TO envelope_app;
