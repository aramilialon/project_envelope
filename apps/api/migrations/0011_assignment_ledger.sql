-- Replaces monthly_assignments (migration 0007) with an append-only ledger
-- (ADR 0008): two devices editing the same category+month total offline is
-- exactly what field-level last-write-wins loses silently; separate
-- immutable rows never conflict. No real deployment has assignment data
-- yet, so there is nothing to migrate beyond dropping the old table.
DROP TABLE monthly_assignments;

CREATE TABLE assignment_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  source_category_id uuid REFERENCES categories (id) ON DELETE RESTRICT,
  destination_category_id uuid REFERENCES categories (id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  author uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Unique where not null: a row can be undone at most once (ADR 0008).
  reverses uuid UNIQUE REFERENCES assignment_ledger (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_category_id IS NOT NULL OR destination_category_id IS NOT NULL),
  CHECK (source_category_id IS DISTINCT FROM destination_category_id)
);

-- Every read aggregates by workspace and month; undoing a batch looks up every row that shares it.
CREATE INDEX assignment_ledger_workspace_id_month_idx ON assignment_ledger (workspace_id, month);
CREATE INDEX assignment_ledger_batch_id_idx ON assignment_ledger (batch_id);

ALTER TABLE assignment_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON assignment_ledger
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Append-only: envelope_app gets no UPDATE/DELETE grant (matches audit_log, migration 0009).
GRANT SELECT, INSERT ON assignment_ledger TO envelope_app;
