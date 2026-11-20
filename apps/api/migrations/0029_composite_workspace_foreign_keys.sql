-- Workspace-scoped foreign keys become composite, so a row can never point at another
-- workspace's row (#504; ADR 0006, "Foreign keys bypass Row-Level Security").
--
-- PostgreSQL checks a foreign key as the owner of the referenced table, without applying
-- Row-Level Security, so with a plain `account_id REFERENCES accounts (id)` a row in workspace A
-- could reference workspace B's account as soon as its UUID was known: RLS hides B's rows from
-- reads and writes, but not from the foreign key check. A composite key
-- `(workspace_id, account_id) REFERENCES accounts (workspace_id, id)` makes that row impossible,
-- because the referenced row must carry the same workspace_id as the referencing one.
--
-- Every foreign key between two workspace-scoped tables, and its unchanged ON DELETE behaviour:
--
--   categories.group_id                                  -> category_groups          CASCADE
--   accounts.payment_category_id (nullable)              -> categories               NO ACTION
--   transactions.account_id                              -> accounts                 CASCADE
--   transactions.transfer_id (nullable)                  -> transactions             SET NULL
--   transactions.reconciliation_id (nullable)            -> reconciliations          SET NULL
--   splits.transaction_id                                -> transactions             CASCADE
--   splits.category_id (nullable)                        -> categories               RESTRICT
--   assignment_ledger.source_category_id (nullable)      -> categories               RESTRICT
--   assignment_ledger.destination_category_id (nullable) -> categories               RESTRICT
--   assignment_ledger.reverses (nullable)                -> assignment_ledger        RESTRICT
--   goals.category_id                                    -> categories               CASCADE
--   import_mappings.account_id                           -> accounts                 CASCADE
--   staged_transactions.account_id                       -> accounts                 CASCADE
--   staged_transactions.duplicate_of (nullable)          -> transactions             SET NULL
--   reconciliations.account_id                           -> accounts                 CASCADE
--   notified_budget_problems.category_id (nullable)      -> categories               CASCADE
--   scheduled_transactions.account_id                    -> accounts                 CASCADE
--   scheduled_transaction_splits.scheduled_transaction_id -> scheduled_transactions  CASCADE
--   scheduled_transaction_splits.category_id (nullable)  -> categories               RESTRICT
--
-- Not changed, because they do not point from one workspace's row to another's:
-- every `workspace_id -> workspaces (id)` (the workspace itself), the references to `users`
-- (memberships.user_id, audit_log.user_id, assignment_ledger.author, reconciliations.user_id,
-- device_tokens.user_id: a user is global, not workspace data), and
-- notification_deliveries.device_token_id (user-scoped, migration 0018). change_log.entity_id
-- has no foreign key at all. Every workspace-scoped table already carries its own workspace_id
-- (ADR 0006), so no column needs adding.
--
-- Nullable columns use MATCH SIMPLE (the default): a null id skips the check, as before. The
-- SET NULL actions name their column, `ON DELETE SET NULL (transfer_id)`, so that deleting the
-- referenced row clears only the id and never the NOT NULL workspace_id beside it.
-- Each constraint keeps its previous name.
--
-- row_security is turned off for this migration's transaction (ADR 0006): under FORCE ROW LEVEL
-- SECURITY a migrating role that is neither superuser nor BYPASSRLS would otherwise see no rows,
-- so the guard below and the validation done by ADD CONSTRAINT would silently check nothing.
-- With it off, such a role gets an error instead.
SET LOCAL row_security = off;

-- 1. Refuse to run on data that already crosses workspaces, with a message naming every
--    offending column, rather than failing on the first ADD CONSTRAINT with a generic error.
DO $$
DECLARE
  reference record;
  offending bigint;
  problems text := '';
BEGIN
  FOR reference IN
    SELECT * FROM (VALUES
      ('categories', 'group_id', 'category_groups'),
      ('accounts', 'payment_category_id', 'categories'),
      ('transactions', 'account_id', 'accounts'),
      ('transactions', 'transfer_id', 'transactions'),
      ('transactions', 'reconciliation_id', 'reconciliations'),
      ('splits', 'transaction_id', 'transactions'),
      ('splits', 'category_id', 'categories'),
      ('assignment_ledger', 'source_category_id', 'categories'),
      ('assignment_ledger', 'destination_category_id', 'categories'),
      ('assignment_ledger', 'reverses', 'assignment_ledger'),
      ('goals', 'category_id', 'categories'),
      ('import_mappings', 'account_id', 'accounts'),
      ('staged_transactions', 'account_id', 'accounts'),
      ('staged_transactions', 'duplicate_of', 'transactions'),
      ('reconciliations', 'account_id', 'accounts'),
      ('notified_budget_problems', 'category_id', 'categories'),
      ('scheduled_transactions', 'account_id', 'accounts'),
      ('scheduled_transaction_splits', 'scheduled_transaction_id', 'scheduled_transactions'),
      ('scheduled_transaction_splits', 'category_id', 'categories')
    ) AS r (child_table, child_column, parent_table)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I child JOIN %I parent ON parent.id = child.%I WHERE parent.workspace_id <> child.workspace_id',
      reference.child_table, reference.parent_table, reference.child_column
    ) INTO offending;
    IF offending > 0 THEN
      problems := problems || format(E'\n  %s.%s -> %s: %s row(s)',
        reference.child_table, reference.child_column, reference.parent_table, offending);
    END IF;
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION 'Migration 0029 cannot make foreign keys composite: these rows reference a row of another workspace:%', problems
      USING HINT = 'Fix or delete those rows (each must reference a row of its own workspace), then run the migrations again.';
  END IF;
END
$$;

-- 2. A UNIQUE (workspace_id, id) key on every referenced table, for the composite foreign keys
--    to point at. Named <table>_workspace_id_id_key, PostgreSQL's own default name, and added only
--    if missing: a branch adding the same key to `accounts` in its own migration must apply
--    cleanly whichever of the two runs first.
DO $$
DECLARE
  referenced_table text;
BEGIN
  FOREACH referenced_table IN ARRAY ARRAY[
    'category_groups', 'categories', 'accounts', 'transactions', 'reconciliations',
    'assignment_ledger', 'scheduled_transactions'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT FROM pg_constraint
      WHERE conrelid = format('public.%I', referenced_table)::regclass
        AND conname = referenced_table || '_workspace_id_id_key'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (workspace_id, id)',
        referenced_table, referenced_table || '_workspace_id_id_key');
    END IF;
  END LOOP;
END
$$;

-- 3. Replace each foreign key with its composite form, same name, same ON DELETE.
ALTER TABLE categories
  DROP CONSTRAINT categories_group_id_fkey,
  ADD CONSTRAINT categories_group_id_fkey FOREIGN KEY (workspace_id, group_id)
    REFERENCES category_groups (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE accounts
  DROP CONSTRAINT accounts_payment_category_id_fkey,
  ADD CONSTRAINT accounts_payment_category_id_fkey FOREIGN KEY (workspace_id, payment_category_id)
    REFERENCES categories (workspace_id, id) MATCH SIMPLE;

ALTER TABLE transactions
  DROP CONSTRAINT transactions_account_id_fkey,
  ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT transactions_transfer_id_fkey,
  ADD CONSTRAINT transactions_transfer_id_fkey FOREIGN KEY (workspace_id, transfer_id)
    REFERENCES transactions (workspace_id, id) MATCH SIMPLE ON DELETE SET NULL (transfer_id),
  DROP CONSTRAINT transactions_reconciliation_id_fkey,
  ADD CONSTRAINT transactions_reconciliation_id_fkey FOREIGN KEY (workspace_id, reconciliation_id)
    REFERENCES reconciliations (workspace_id, id) MATCH SIMPLE ON DELETE SET NULL (reconciliation_id);

ALTER TABLE splits
  DROP CONSTRAINT splits_transaction_id_fkey,
  ADD CONSTRAINT splits_transaction_id_fkey FOREIGN KEY (workspace_id, transaction_id)
    REFERENCES transactions (workspace_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT splits_category_id_fkey,
  ADD CONSTRAINT splits_category_id_fkey FOREIGN KEY (workspace_id, category_id)
    REFERENCES categories (workspace_id, id) MATCH SIMPLE ON DELETE RESTRICT;

ALTER TABLE assignment_ledger
  DROP CONSTRAINT assignment_ledger_source_category_id_fkey,
  ADD CONSTRAINT assignment_ledger_source_category_id_fkey FOREIGN KEY (workspace_id, source_category_id)
    REFERENCES categories (workspace_id, id) MATCH SIMPLE ON DELETE RESTRICT,
  DROP CONSTRAINT assignment_ledger_destination_category_id_fkey,
  ADD CONSTRAINT assignment_ledger_destination_category_id_fkey FOREIGN KEY (workspace_id, destination_category_id)
    REFERENCES categories (workspace_id, id) MATCH SIMPLE ON DELETE RESTRICT,
  DROP CONSTRAINT assignment_ledger_reverses_fkey,
  ADD CONSTRAINT assignment_ledger_reverses_fkey FOREIGN KEY (workspace_id, reverses)
    REFERENCES assignment_ledger (workspace_id, id) MATCH SIMPLE ON DELETE RESTRICT;

ALTER TABLE goals
  DROP CONSTRAINT goals_category_id_fkey,
  ADD CONSTRAINT goals_category_id_fkey FOREIGN KEY (workspace_id, category_id)
    REFERENCES categories (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE import_mappings
  DROP CONSTRAINT import_mappings_account_id_fkey,
  ADD CONSTRAINT import_mappings_account_id_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE staged_transactions
  DROP CONSTRAINT staged_transactions_account_id_fkey,
  ADD CONSTRAINT staged_transactions_account_id_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT staged_transactions_duplicate_of_fkey,
  ADD CONSTRAINT staged_transactions_duplicate_of_fkey FOREIGN KEY (workspace_id, duplicate_of)
    REFERENCES transactions (workspace_id, id) MATCH SIMPLE ON DELETE SET NULL (duplicate_of);

ALTER TABLE reconciliations
  DROP CONSTRAINT reconciliations_account_id_fkey,
  ADD CONSTRAINT reconciliations_account_id_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE notified_budget_problems
  DROP CONSTRAINT notified_budget_problems_category_id_fkey,
  ADD CONSTRAINT notified_budget_problems_category_id_fkey FOREIGN KEY (workspace_id, category_id)
    REFERENCES categories (workspace_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE scheduled_transactions
  DROP CONSTRAINT scheduled_transactions_account_id_fkey,
  ADD CONSTRAINT scheduled_transactions_account_id_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE scheduled_transaction_splits
  DROP CONSTRAINT scheduled_transaction_splits_scheduled_transaction_id_fkey,
  ADD CONSTRAINT scheduled_transaction_splits_scheduled_transaction_id_fkey FOREIGN KEY (workspace_id, scheduled_transaction_id)
    REFERENCES scheduled_transactions (workspace_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT scheduled_transaction_splits_category_id_fkey,
  ADD CONSTRAINT scheduled_transaction_splits_category_id_fkey FOREIGN KEY (workspace_id, category_id)
    REFERENCES categories (workspace_id, id) MATCH SIMPLE ON DELETE RESTRICT;
