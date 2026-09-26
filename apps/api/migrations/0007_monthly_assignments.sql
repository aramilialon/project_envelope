-- spent and available are computed from splits, never stored (design.md, "Accounting rules").
CREATE TABLE monthly_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  assigned_cents bigint NOT NULL,
  UNIQUE (category_id, month)
);

CREATE INDEX monthly_assignments_workspace_id_idx ON monthly_assignments (workspace_id);
