-- A transfer between two accounts is two transaction rows pointing at each other
-- through transfer_id, one per account, with no category (see docs/adr/0006-row-level-security.md
-- for why every table below repeats workspace_id instead of leaving it only on transactions).
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  payee text,
  memo text,
  status text NOT NULL CHECK (status IN ('pending', 'cleared', 'reconciled')),
  transfer_id uuid REFERENCES transactions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transactions_workspace_id_idx ON transactions (workspace_id);
CREATE INDEX transactions_account_id_idx ON transactions (account_id);

CREATE TABLE splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories (id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL,
  memo text
);

CREATE INDEX splits_workspace_id_idx ON splits (workspace_id);
CREATE INDEX splits_transaction_id_idx ON splits (transaction_id);
CREATE INDEX splits_category_id_idx ON splits (category_id);
