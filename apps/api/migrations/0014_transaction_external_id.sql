-- The bank's own transaction id (OFX's FITID, #29), kept once a staged row
-- is confirmed into a real transaction, so a later re-import of the same
-- statement matches it precisely instead of falling back to the amount/date
-- window (design.md, "Import and reconciliation"; packages/core's
-- detectDuplicates already tries this match first).
ALTER TABLE transactions ADD COLUMN external_id text;

CREATE INDEX transactions_external_id_idx ON transactions (account_id, external_id) WHERE external_id IS NOT NULL;
