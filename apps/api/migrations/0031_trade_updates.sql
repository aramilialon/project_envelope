-- Editing and deleting trades (#509; ADR 0012).
--
-- Migration 0030 granted envelope_app only SELECT and INSERT on trades. Editing a trade rewrites its
-- row (and its cash leg, in the same transaction); deleting it removes the row, and its cash leg
-- goes with it through transactions_trade_id_fkey's ON DELETE CASCADE.
GRANT UPDATE, DELETE ON trades TO envelope_app;

-- A trade moved to another account takes its cash leg with it: the leg's key
-- (workspace_id, trade_id, account_id) follows the trade's (workspace_id, id, account_id) through
-- ON UPDATE CASCADE, so the leg can never sit on any account but its trade's, whichever code path
-- changes the trade (the trades API, or a synced change to the trade later). Otherwise the same
-- constraint as migration 0030's, under the same name.
ALTER TABLE transactions DROP CONSTRAINT transactions_trade_id_fkey;
ALTER TABLE transactions ADD CONSTRAINT transactions_trade_id_fkey FOREIGN KEY (workspace_id, trade_id, account_id)
  REFERENCES trades (workspace_id, id, account_id) MATCH SIMPLE ON UPDATE CASCADE ON DELETE CASCADE;
