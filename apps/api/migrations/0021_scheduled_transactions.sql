-- A scheduled transaction (design.md, "Scheduled transactions"; #22) reserves money ahead of
-- being recorded: packages/core's ScheduledItem (#250) is one row per split here. Automatic
-- materialization on the due date needs the queue module and is a separate, later issue
-- (0.1.5 Queue and notifications) — for now this table is created, read, updated and deleted
-- by hand only, never turned into a real transaction by the server.
CREATE TABLE scheduled_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  payee text,
  memo text,
  next_due_date date NOT NULL,
  recur_every integer NOT NULL CHECK (recur_every > 0),
  recur_unit text NOT NULL CHECK (recur_unit IN ('day', 'month', 'year')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_transactions_workspace_id_idx ON scheduled_transactions (workspace_id);
CREATE INDEX scheduled_transactions_next_due_date_idx ON scheduled_transactions (next_due_date);

-- One row per category, same shape as `splits` (migration 0006): a single row is "a category",
-- several rows are a split template. `amount_cents` is always positive (a scheduled item only
-- ever reserves money, design.md), unlike an ordinary split's signed amount.
CREATE TABLE scheduled_transaction_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  scheduled_transaction_id uuid NOT NULL REFERENCES scheduled_transactions (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  memo text
);

CREATE INDEX scheduled_transaction_splits_workspace_id_idx ON scheduled_transaction_splits (workspace_id);
CREATE INDEX scheduled_transaction_splits_scheduled_transaction_id_idx ON scheduled_transaction_splits (scheduled_transaction_id);

ALTER TABLE scheduled_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scheduled_transactions
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE scheduled_transaction_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_transaction_splits FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scheduled_transaction_splits
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_transactions TO envelope_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_transaction_splits TO envelope_app;
