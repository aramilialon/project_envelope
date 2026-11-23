-- An account's transactions in register order (#560).
--
-- GET .../accounts/:accountId/transactions returns one page at a time, keyed on
-- (occurred_at, created_at, id): a stable order in which no two rows are equal, so a cursor
-- names one exact place in it and no row is skipped or repeated across pages, even when rows are
-- added between two requests. Every query on it filters on the workspace and the account, so this
-- one index serves a page in either direction (ascending, or descending read backwards) without a
-- sort; it also covers what transactions_account_id_idx did, which stays for the other queries
-- that look an account's rows up without the workspace.
CREATE INDEX transactions_account_order_idx ON transactions (workspace_id, account_id, occurred_at, created_at, id);
