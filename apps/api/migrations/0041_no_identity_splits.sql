-- A split changes the quantity held: a 1:1 ratio is refused (#712).
--
-- Until #712 the API accepted a split whose two figures are equal (1:1, 2:2), which changes
-- nothing: the replay scales a quantity by splitTo / splitFrom in integer arithmetic, exactly 1
-- here, with no rounding, and a split touches no cost, no cash (it has no cash leg, and
-- trades_split_check keeps every amount at 0) and no external flow. The API now refuses one
-- (`invalid_trade`, field `splitTo`, @envelope/core's checkTradeFigures); this deletes the rows
-- stored before, and adds the same rule to the table.
--
-- Deleting them changes no position, cost basis, realized gain, cash balance or return, and no
-- other trade's place in the replay (the domain expert's ruling on #712). What a user can see
-- change: those rows leave the trade list; a position whose only row on an account was such a
-- split row, at a quantity of 0, leaves the positions too; a portfolio whose only trades they
-- were can now be deleted. Their "trade.create" entries stay in the audit log, and nothing is
-- written there for the delete, as in migration 0038: no figure a user sees changes.
--
-- A closed account's rows are deleted too. The closed-account guard on trades (migration 0033)
-- would refuse the delete, so that one trigger is turned off for this statement and turned back on
-- below, in the same transaction (never DISABLE TRIGGER ALL, which would also turn off the foreign
-- key checks).
--
-- row_security is turned off for this migration's transaction (ADR 0006, as migrations 0029, 0037
-- and 0038): under FORCE ROW LEVEL SECURITY a migrating role that is neither superuser nor
-- BYPASSRLS would see no rows and silently delete nothing; with it off, such a role gets an error
-- instead.
SET LOCAL row_security = off;

ALTER TABLE trades DISABLE TRIGGER trades_refuse_closed_account;

DELETE FROM trades WHERE type = 'split' AND split_from = split_to;

ALTER TABLE trades ENABLE TRIGGER trades_refuse_closed_account;

-- trades_split_check (migration 0030) already requires both figures on a split, so this needs no
-- null case.
ALTER TABLE trades ADD CONSTRAINT trades_split_identity_check CHECK (type <> 'split' OR split_from <> split_to);
