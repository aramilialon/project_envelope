-- A credit card's starting balance comes first on its day (#706).
--
-- Until #706, creating an on-budget card with debt stored its "Starting balance" transaction at
-- now(), the moment the card was created, while a transaction dated that same day is stored at
-- midnight in the workspace's time zone. Every list orders by occurred_at, then created_at, so a
-- purchase dated the day the card was created came before its starting balance, and the
-- register's running balance for it ran as if the card owed nothing yet. accounts/repository.ts
-- now stores a new starting balance at midnight of its day; this moves the rows written before,
-- keeping their day (in the workspace's time zone, as every screen reads it): only the time
-- changes, so no balance on any day, no budget month and no total moves.
--
-- The rows moved are exactly the ones the old insert wrote, recognised by three things together:
--   * the shape no other transaction has (transactions/repository.ts, isStartingBalanceSplit): on
--     an on-budget credit card, not a transfer and not a trade's cash leg, with one split,
--     categorized to that card's own payment category;
--   * occurred_at equal to created_at: the old insert set both to now() in the same statement, so
--     they are the same instant to the microsecond, which a date entered by anyone is not; a
--     starting balance whose date was later changed is left as it is;
--   * not already at midnight of its day, so running it again changes nothing.
-- The payee is not used: it can have been edited since, which did not move the row.
--
-- A closed card's starting balance is moved too: its day and every balance stay the same. The
-- closed-account guard (migration 0033) would refuse the update, so it is turned off for this
-- statement only and turned back on below, in the same transaction.
--
-- row_security is turned off for this migration's transaction (ADR 0006, as migration 0029): under
-- FORCE ROW LEVEL SECURITY a migrating role that is neither superuser nor BYPASSRLS would see no
-- rows and silently move nothing; with it off, such a role gets an error instead.
SET LOCAL row_security = off;

ALTER TABLE transactions DISABLE TRIGGER transactions_refuse_closed_account;

UPDATE transactions t
SET occurred_at = (t.occurred_at AT TIME ZONE w.time_zone)::date::timestamp AT TIME ZONE w.time_zone
FROM accounts a, workspaces w
WHERE a.workspace_id = t.workspace_id AND a.id = t.account_id
  AND w.id = t.workspace_id
  AND a.type = 'credit_card'
  AND a.on_budget
  AND a.payment_category_id IS NOT NULL
  AND t.transfer_id IS NULL
  AND t.trade_id IS NULL
  AND t.occurred_at = t.created_at
  AND t.occurred_at <> (t.occurred_at AT TIME ZONE w.time_zone)::date::timestamp AT TIME ZONE w.time_zone
  AND (SELECT count(*) FROM splits s WHERE s.workspace_id = t.workspace_id AND s.transaction_id = t.id) = 1
  AND EXISTS (
    SELECT 1 FROM splits s
    WHERE s.workspace_id = t.workspace_id AND s.transaction_id = t.id AND s.category_id = a.payment_category_id
  );

ALTER TABLE transactions ENABLE TRIGGER transactions_refuse_closed_account;
