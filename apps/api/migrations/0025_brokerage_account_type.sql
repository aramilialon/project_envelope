-- A brokerage account (#74): the portfolio connects to the budget through
-- off-budget accounts (design.md, "Portfolio module"), so money paid to the
-- broker is a transfer that leaves the budget without showing up as spending.
-- Only the allowed values change: no existing row needs migrating.
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('checking', 'savings', 'cash', 'credit_card', 'brokerage'));

-- A brokerage account is always off budget, on every write path (insert,
-- a later update, a script). The accounts repository maps a violation to a
-- ValidationError with code "brokerage_on_budget".
ALTER TABLE accounts ADD CONSTRAINT accounts_brokerage_off_budget_check
  CHECK (type <> 'brokerage' OR NOT on_budget);
