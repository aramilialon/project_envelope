-- Import (design.md, "Import and reconciliation"): a saved column mapping
-- per account, and a staging area rows land in before they become real
-- transactions. Never a "to categorize" state in transactions itself
-- (packages/core rejects an uncategorized transaction outright) -- a staged
-- row is confirmed into transactions only once it has a category, or is
-- recognized as a transfer or as income.
CREATE TABLE import_mappings (
  account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- The mapping's own shape (columns, date format, decimal separator, header
  -- row) is packages/core's concern (src/import/csv.ts), not this table's.
  mapping jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_mappings_workspace_id_idx ON import_mappings (workspace_id);

CREATE TABLE staged_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The bank's own transaction id, when the source format carries one.
  external_id text,
  occurred_at date NOT NULL,
  payee text,
  memo text,
  amount_cents bigint NOT NULL,
  -- Set when duplicate detection (packages/core, #27) matched this row
  -- against a transaction already in the account: confirming it turns that
  -- transaction cleared instead of creating a new one.
  duplicate_of uuid REFERENCES transactions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staged_transactions_workspace_id_idx ON staged_transactions (workspace_id);
CREATE INDEX staged_transactions_account_id_idx ON staged_transactions (account_id);
-- Unconfirmed staged rows expire after 7 days: the read path sweeps by this.
CREATE INDEX staged_transactions_created_at_idx ON staged_transactions (created_at);

ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON import_mappings
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON import_mappings TO envelope_app;

ALTER TABLE staged_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staged_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON staged_transactions
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());
-- No UPDATE: a staged row is either confirmed away (DELETE, becomes a real
-- transaction) or swept by expiry (DELETE) -- never edited in place.
GRANT SELECT, INSERT, DELETE ON staged_transactions TO envelope_app;
