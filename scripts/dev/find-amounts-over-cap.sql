-- Lists the stored amounts above the cap on a single amount (#651, ADR 0002): 10^11 minor units,
-- €1,000,000,000.00 in a currency with two decimals. The API refuses these on every write path
-- since #651, but a database written before that may still hold some. Such a row still reads,
-- but a few of them can make the sum of a workspace's amounts leave the safe integer range, and
-- every budget-month read of that workspace then fails with 422 `amount_total_overflow`.
--
-- A transaction is listed when one of its splits, or its own amount (the sum of its splits), is
-- above the cap; a trade when any of its figures is.
--
-- Read-only. Run it as the table owner (the `envelope` role, DATABASE_URL), which Row-Level
-- Security does not restrict, so it sees every workspace:
--
--   psql "$DATABASE_URL" -f scripts/dev/find-amounts-over-cap.sql
--
-- No rows means there is nothing to fix. How to fix one by hand: apps/api/README.md,
-- "Amounts above the cap stored before #651".

WITH cap AS (SELECT 100000000000::bigint AS max)
SELECT 'transaction' AS kind, t.workspace_id, t.id, t.account_id AS account_id,
       sum(s.amount_cents)::numeric AS amount_cents, max(abs(s.amount_cents))::numeric AS largest_part_cents
FROM transactions t
JOIN splits s ON s.transaction_id = t.id
GROUP BY t.workspace_id, t.id, t.account_id
HAVING abs(sum(s.amount_cents::numeric)) > (SELECT max FROM cap) OR max(abs(s.amount_cents)) > (SELECT max FROM cap)
UNION ALL
SELECT 'scheduled transaction', st.workspace_id, st.id, st.account_id,
       sum(s.amount_cents)::numeric, max(abs(s.amount_cents))::numeric
FROM scheduled_transactions st
JOIN scheduled_transaction_splits s ON s.scheduled_transaction_id = st.id
GROUP BY st.workspace_id, st.id, st.account_id
HAVING abs(sum(s.amount_cents::numeric)) > (SELECT max FROM cap) OR max(abs(s.amount_cents)) > (SELECT max FROM cap)
UNION ALL
SELECT 'assignment', workspace_id, id, NULL, amount_cents::numeric, NULL
FROM assignment_ledger
WHERE abs(amount_cents) > (SELECT max FROM cap)
UNION ALL
SELECT 'goal', workspace_id, id, NULL, amount_cents::numeric, NULL
FROM goals
WHERE abs(amount_cents) > (SELECT max FROM cap)
UNION ALL
SELECT 'reconciliation', workspace_id, id, account_id, statement_balance_cents::numeric, NULL
FROM reconciliations
WHERE abs(statement_balance_cents) > (SELECT max FROM cap)
UNION ALL
SELECT 'staged transaction', workspace_id, id, account_id, amount_cents::numeric, NULL
FROM staged_transactions
WHERE abs(amount_cents) > (SELECT max FROM cap)
UNION ALL
SELECT 'trade', workspace_id, id, account_id, gross_cents::numeric,
       greatest(abs(gross_cents), abs(fees_cents), abs(transaction_tax_cents), abs(accrued_interest_cents),
                abs(withholding_foreign_cents), abs(withholding_domestic_cents), abs(gain_tax_cents),
                abs(coalesce(cost_basis_cents, 0)))::numeric
FROM trades
WHERE greatest(abs(gross_cents), abs(fees_cents), abs(transaction_tax_cents), abs(accrued_interest_cents),
               abs(withholding_foreign_cents), abs(withholding_domestic_cents), abs(gain_tax_cents),
               abs(coalesce(cost_basis_cents, 0))) > (SELECT max FROM cap)
ORDER BY workspace_id, kind, id;
