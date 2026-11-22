-- Untimed trades keep the place they had in their history (#596).
--
-- Until #596, a trade recorded without a time (occurred_at null) sorted in the replay at midnight
-- UTC of its date. It now sorts at the start of its date in the workspace's time zone
-- (trades/repository.ts, REPLAY_ORDER and localDayStartSql; @envelope/core's startOfLocalDay):
-- the first midnight where midnight comes twice, the instant the clocks jump where it is skipped.
-- East of UTC that start comes before midnight UTC, so a trade timed between the two (in
-- Europe/Rome, 00:30 local time) used to come before an untimed trade of the same instrument and
-- date and now comes after it. A history that replayed before could then fail the replay
-- (a sale before the buy it needs), or give another cost basis or realized gain (the cost each
-- sale removes is rounded), and any edit of it would be refused.
--
-- This gives exactly those untimed trades the instant they sorted at until now, midnight UTC of
-- their date, so every history replays in the order it had: no position, cost basis or total
-- changes. The trades moved are the untimed ones in a group (workspace, instrument, date) that
-- also holds a trade timed at or after the start of the date in the workspace's time zone and
-- before midnight UTC of it: the only groups the new order reorders. Elsewhere, and in every
-- workspace on or west of UTC (a trade's time is always on its date there, so after both), an
-- untimed trade already sorts where it did. Every untimed trade of such a group is moved (a split
-- row too, though a split sorts first on its date whatever its time). A fee or a tax recorded
-- without an instrument is left alone: its group's instrument is null, which matches nothing
-- below, and the order of such charges changes no amount. Midnight UTC of a date east of UTC is
-- still on that date in the workspace's time zone, so a moved trade passes the API's check that a
-- trade's time falls on its date when it is edited later.
--
-- Only trades.occurred_at changes. A trade's cash leg is dated from its trade date, never from its
-- time (transactions/repository.ts, rewriteTradeCashLeg), so it stays as it is; a reconciled cash
-- leg is locked by the API only and is not touched. Nothing is written to the audit log: no value
-- a user sees changes, only the stored time of an untimed trade, which the API now returns as set.
-- A second run changes nothing: every moved trade has a time, and the remaining untimed trades are
-- in no group the query finds.
--
-- A closed account's trades are moved too. The closed-account guard on trades (migration 0033)
-- would refuse the update, so that one trigger is turned off for this statement and turned back on
-- below, in the same transaction (never DISABLE TRIGGER ALL, which would also turn off the foreign
-- key checks).
--
-- row_security is turned off for this migration's transaction (ADR 0006, as migrations 0029 and
-- 0037): under FORCE ROW LEVEL SECURITY a migrating role that is neither superuser nor BYPASSRLS
-- would see no rows and silently move nothing; with it off, such a role gets an error instead.
SET LOCAL row_security = off;

ALTER TABLE trades DISABLE TRIGGER trades_refuse_closed_account;

UPDATE trades t
SET occurred_at = t.trade_date::timestamp AT TIME ZONE 'UTC'
FROM (
  SELECT g.workspace_id, g.instrument_id, g.trade_date
  FROM trades g
  JOIN workspaces w ON w.id = g.workspace_id
  GROUP BY g.workspace_id, g.instrument_id, g.trade_date
  -- A timed trade in the window; an untimed one gives null here, which bool_or skips.
  HAVING bool_or(
    g.occurred_at < g.trade_date::timestamp AT TIME ZONE 'UTC'
    -- The start of the date in the workspace's time zone, as localDayStartSql gives it.
    AND g.occurred_at >= LEAST(
      g.trade_date::timestamp AT TIME ZONE w.time_zone,
      CASE WHEN ((g.trade_date::timestamp - interval '3 hours') AT TIME ZONE w.time_zone + interval '3 hours')
                  AT TIME ZONE w.time_zone = g.trade_date::timestamp
           THEN (g.trade_date::timestamp - interval '3 hours') AT TIME ZONE w.time_zone + interval '3 hours'
      END
    )
  )
) AS affected
WHERE t.workspace_id = affected.workspace_id
  AND t.instrument_id = affected.instrument_id
  AND t.trade_date = affected.trade_date
  AND t.occurred_at IS NULL;

ALTER TABLE trades ENABLE TRIGGER trades_refuse_closed_account;
