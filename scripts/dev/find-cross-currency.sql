-- Lists what mixes currencies (#652): an on-budget account (card included) whose currency is not
-- its workspace's base currency, and a transfer whose two legs are on accounts in different
-- currencies. The API refuses both on every write path since #652 (`account_currency_not_base`,
-- `currency_mismatch`), but a database written before that may still hold some: their amounts
-- were added to the budget, or moved from one currency to another one for one, as if the two
-- currencies were the same.
--
-- It also lists a workspace or an account whose currency is not three upper-case letters (such as
-- "eur" or "EURO"), which the API refuses since #652 (`invalid_currency`): a workspace with such a
-- base currency cannot hold an on-budget account, and such an account's amounts are shown with the
-- bare code. A well-formed code the runtime does not know ("XYZ", the withdrawn "VEF") is beyond
-- what SQL can check, so it is not listed.
--
-- Read-only. Run it as the table owner (the `envelope` role, DATABASE_URL), which Row-Level
-- Security does not restrict, so it sees every workspace:
--
--   psql "$DATABASE_URL" -f scripts/dev/find-cross-currency.sql
--
-- No rows means there is nothing to fix. How to fix one by hand: apps/api/README.md,
-- "Currencies mixed before #652".

SELECT 'on_budget_account' AS kind,
       a.workspace_id,
       w.base_currency,
       a.id,
       a.name AS account,
       a.type,
       a.currency,
       NULL::uuid AS other_leg_id,
       NULL::text AS other_account,
       NULL::text AS other_currency,
       NULL::text AS date,
       NULL::bigint AS amount_cents,
       a.closed_at IS NOT NULL AS closed
FROM accounts a
JOIN workspaces w ON w.id = a.workspace_id
WHERE a.on_budget
  AND a.currency <> w.base_currency

UNION ALL

SELECT 'malformed_workspace_currency' AS kind,
       w.id AS workspace_id,
       w.base_currency,
       w.id,
       NULL::text AS account,
       NULL::text AS type,
       w.base_currency AS currency,
       NULL::uuid AS other_leg_id,
       NULL::text AS other_account,
       NULL::text AS other_currency,
       NULL::text AS date,
       NULL::bigint AS amount_cents,
       NULL::boolean AS closed
FROM workspaces w
WHERE w.base_currency !~ '^[A-Z]{3}$'

UNION ALL

SELECT 'malformed_account_currency' AS kind,
       a.workspace_id,
       w.base_currency,
       a.id,
       a.name AS account,
       a.type,
       a.currency,
       NULL::uuid AS other_leg_id,
       NULL::text AS other_account,
       NULL::text AS other_currency,
       NULL::text AS date,
       NULL::bigint AS amount_cents,
       a.closed_at IS NOT NULL AS closed
FROM accounts a
JOIN workspaces w ON w.id = a.workspace_id
WHERE a.currency !~ '^[A-Z]{3}$'

UNION ALL

-- One row per transfer, from its outgoing leg (the negative split).
SELECT 'cross_currency_transfer' AS kind,
       t.workspace_id,
       w.base_currency,
       t.id,
       a.name AS account,
       a.type,
       a.currency,
       p.id AS other_leg_id,
       pa.name AS other_account,
       pa.currency AS other_currency,
       to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS date,
       (SELECT sum(s.amount_cents) FROM splits s WHERE s.transaction_id = t.id)::bigint AS amount_cents,
       NULL::boolean AS closed
FROM transactions t
JOIN workspaces w ON w.id = t.workspace_id
JOIN accounts a ON a.id = t.account_id
JOIN transactions p ON p.id = t.transfer_id AND p.workspace_id = t.workspace_id
JOIN accounts pa ON pa.id = p.account_id
WHERE a.currency <> pa.currency
  AND (SELECT sum(s.amount_cents) FROM splits s WHERE s.transaction_id = t.id) < 0

ORDER BY kind, workspace_id, date NULLS FIRST, account;
