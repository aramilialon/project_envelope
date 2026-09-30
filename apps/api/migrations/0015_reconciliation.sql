-- Reconciliation (design.md, "Import and reconciliation", #32): one row per
-- completed reconciliation event, kept in the account's history. Unlocking
-- a reconciled transaction marks the reconciliation it belonged to as
-- broken (below) rather than deleting it: the record of what happened
-- stays, only its "still valid" status changes.
CREATE TABLE reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reconciled_at date NOT NULL,
  statement_balance_cents bigint NOT NULL,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Set when a transaction reconciled here is later unlocked: this reconciliation no longer
  -- counts as the account's "last" one for a future attempt, until redone.
  broken_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reconciliations_workspace_id_idx ON reconciliations (workspace_id);
CREATE INDEX reconciliations_account_id_idx ON reconciliations (account_id);

ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON reconciliations
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());
-- UPDATE only ever sets broken_at (the unlock action, #32); everything else about a
-- completed reconciliation is immutable, and there is no DELETE at all.
GRANT SELECT, INSERT, UPDATE ON reconciliations TO envelope_app;

-- Which reconciliation event, if any, last reconciled this transaction — kept even after an
-- unlock, so the transaction's own history stays intact.
ALTER TABLE transactions ADD COLUMN reconciliation_id uuid REFERENCES reconciliations (id) ON DELETE SET NULL;
