-- The tax regime of brokerage accounts (#508; design.md, "Portfolio module").
--
-- A workspace's tax country decides whether a brokerage account needs a regime: today only
-- 'IT' does. The regime is a history, not a single column, so a later change never
-- reinterprets trades already recorded: a trade uses the regime in force on its own date.
-- Existing rows need no data migration: every workspace starts with no tax country, every
-- account with no withholding-agent flag and no regime.

-- ISO 3166-1 alpha-2. The application checks the code is a real region; this only keeps the shape.
ALTER TABLE workspaces ADD COLUMN tax_country text
  CONSTRAINT workspaces_tax_country_check CHECK (tax_country ~ '^[A-Z]{2}$');

-- Whether the broker is a domestic (Italian) withholding agent: brokerage accounts only.
-- The accounts repository maps a violation to a ValidationError with code
-- "tax_regime_not_applicable".
ALTER TABLE accounts ADD COLUMN domestic_withholding_agent boolean;
ALTER TABLE accounts ADD CONSTRAINT accounts_withholding_agent_brokerage_check
  CHECK (domestic_withholding_agent IS NULL OR type = 'brokerage');

-- The target of the composite foreign key below, which keeps a regime in its account's own
-- workspace. Another migration may add the same constraint under the same name, so it is
-- added only when missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_constraint
    WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_workspace_id_id_key'
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_workspace_id_id_key UNIQUE (workspace_id, id);
  END IF;
END
$$;

-- One row per regime period: a row applies from valid_from until the next row's valid_from.
-- The primary key rules out two rows on the same date (code "tax_regime_duplicate_date").
CREATE TABLE account_tax_regimes (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  valid_from date NOT NULL,
  regime text NOT NULL
    CONSTRAINT account_tax_regimes_regime_check CHECK (regime IN ('self_declared', 'administered', 'managed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_tax_regimes_pkey PRIMARY KEY (account_id, valid_from),
  CONSTRAINT account_tax_regimes_account_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX account_tax_regimes_workspace_id_idx ON account_tax_regimes (workspace_id);

-- The rules a CHECK constraint cannot express, because they read other rows: only a brokerage
-- account has a regime (code "tax_regime_not_applicable"), and once an account has a regime,
-- every row except the earliest starts on 1 January (code "tax_regime_change_not_year_start").
-- Locking the account row serializes two concurrent inserts for the same account. Each
-- violation is raised as a check_violation naming its own constraint, so the repository maps
-- it the same way as a real CHECK constraint.
CREATE FUNCTION account_tax_regimes_check() RETURNS trigger AS $$
DECLARE
  account_type text;
  earliest date;
BEGIN
  SELECT type INTO account_type FROM accounts
  WHERE id = NEW.account_id AND workspace_id = NEW.workspace_id
  FOR UPDATE;
  IF account_type IS NULL THEN
    -- No such account in this workspace: the foreign key rejects the row.
    RETURN NEW;
  END IF;
  IF account_type <> 'brokerage' THEN
    RAISE EXCEPTION 'only a brokerage account has a tax regime'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_tax_regimes_brokerage_check';
  END IF;

  SELECT min(valid_from) INTO earliest FROM account_tax_regimes WHERE account_id = NEW.account_id;
  IF earliest IS NOT NULL AND (
    (NEW.valid_from > earliest AND to_char(NEW.valid_from, 'MM-DD') <> '01-01')
    OR (NEW.valid_from < earliest AND to_char(earliest, 'MM-DD') <> '01-01')
  ) THEN
    RAISE EXCEPTION 'a tax regime change must start on 1 January'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_tax_regimes_year_start_check';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_tax_regimes_check
  BEFORE INSERT ON account_tax_regimes
  FOR EACH ROW EXECUTE FUNCTION account_tax_regimes_check();

ALTER TABLE account_tax_regimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_tax_regimes FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON account_tax_regimes
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- No UPDATE: a change of regime is a new row, and editing one in place would bypass the
-- trigger above, which only runs on INSERT.
GRANT SELECT, INSERT, DELETE ON account_tax_regimes TO envelope_app;
