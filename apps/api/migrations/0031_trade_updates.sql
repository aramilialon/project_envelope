-- Editing and deleting trades (#509; ADR 0012).
--
-- Migration 0030 granted envelope_app only SELECT and INSERT on trades. Editing a trade rewrites its
-- row (and its cash leg, in the same transaction); deleting it removes the row, and its cash leg
-- goes with it through transactions_trade_id_fkey's ON DELETE CASCADE.
--
-- UPDATE only on the columns an edit writes (the API's updateTradeRow): a trade's id, workspace,
-- type, creation time and the link between a transfer's two legs never change once written.
GRANT UPDATE (
  account_id, portfolio_id, instrument_id, trade_date, occurred_at,
  quantity_e8, price_e6, gross_cents, fees_cents, transaction_tax_cents, accrued_interest_cents,
  withholding_foreign_cents, withholding_domestic_cents, gain_tax_cents,
  tax_kind, cost_basis_cents, split_from, split_to, memo
) ON trades TO envelope_app;
GRANT DELETE ON trades TO envelope_app;

-- A trade moved to another account takes its cash leg with it: the leg's key
-- (workspace_id, trade_id, account_id) follows the trade's (workspace_id, id, account_id) through
-- ON UPDATE CASCADE, so the leg can never sit on any account but its trade's, whichever code path
-- changes the trade (the trades API, or a synced change to the trade later). Otherwise the same
-- constraint as migration 0030's, under the same name.
ALTER TABLE transactions DROP CONSTRAINT transactions_trade_id_fkey;
ALTER TABLE transactions ADD CONSTRAINT transactions_trade_id_fkey FOREIGN KEY (workspace_id, trade_id, account_id)
  REFERENCES trades (workspace_id, id, account_id) MATCH SIMPLE ON UPDATE CASCADE ON DELETE CASCADE;
