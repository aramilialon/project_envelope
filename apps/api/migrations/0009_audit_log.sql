-- Append-only audit trail (design.md, "Data model"; #216). Records who did
-- what, when, and the before/after state, for reconciliation's "unlock"
-- action and, later, authentication and membership events.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_workspace_id_idx ON audit_log (workspace_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON audit_log
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Append-only: envelope_app gets no UPDATE/DELETE grant, so no policy for
-- those commands is needed either — the privilege check fails first.
GRANT SELECT, INSERT ON audit_log TO envelope_app;
