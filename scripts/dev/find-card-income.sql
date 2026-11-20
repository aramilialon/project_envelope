-- Lists the rows that store income on an on-budget credit card (#548): a transaction or a
-- scheduled transaction with a single split and no category, on an on-budget credit card,
-- that is not a transfer leg. The API refuses these on every write path since #548, but a
-- database written before that may still hold some, and one such transaction makes every
-- budget-month read of its workspace fail with 400 `unsupported_transaction`.
--
-- Read-only. Run it as the table owner (the `envelope` role, DATABASE_URL), which Row-Level
-- Security does not restrict, so it sees every workspace:
--
--   psql "$DATABASE_URL" -f scripts/dev/find-card-income.sql
--
-- No rows means there is nothing to fix. How to fix one by hand: apps/api/README.md,
-- "Income on a credit card stored before #548".

SELECT 'transaction' AS kind,
       t.workspace_id,
       a.name AS account,
       t.id,
       to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS date,
       t.payee,
       s.amount_cents,
       t.status
FROM transactions t
JOIN workspaces w ON w.id = t.workspace_id
JOIN accounts a ON a.id = t.account_id
JOIN splits s ON s.transaction_id = t.id
WHERE a.type = 'credit_card'
  AND a.on_budget
  AND t.transfer_id IS NULL
  AND s.category_id IS NULL
  AND (SELECT count(*) FROM splits o WHERE o.transaction_id = t.id) = 1
UNION ALL
SELECT 'scheduled transaction' AS kind,
       st.workspace_id,
       a.name AS account,
       st.id,
       to_char(st.next_due_date, 'YYYY-MM-DD') AS date,
       st.payee,
       s.amount_cents,
       NULL AS status
FROM scheduled_transactions st
JOIN accounts a ON a.id = st.account_id
JOIN scheduled_transaction_splits s ON s.scheduled_transaction_id = st.id
WHERE a.type = 'credit_card'
  AND a.on_budget
  AND s.category_id IS NULL
  AND (SELECT count(*) FROM scheduled_transaction_splits o WHERE o.scheduled_transaction_id = st.id) = 1
ORDER BY workspace_id, kind, date;
