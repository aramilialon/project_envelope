-- Private instruments (#505; ADR 0019's plan for 0.2.1; design.md, "Portfolio module" and
-- "Data model").
--
-- An instrument can now belong to one workspace: an asset with no ISIN and no exchange ticker
-- (real estate, a company pension fund, private company shares) that counts in that workspace's
-- holdings and nowhere else. `workspace_id` null is the shared catalog of migration 0026, as every
-- existing row stays; set, the row is that workspace's own and no other workspace sees it.
--
-- No data migration: every existing row is shared, and so are the rows the API adds through
-- POST /instruments.
ALTER TABLE instruments
  ADD COLUMN workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE;

-- A shared instrument is still a listing: an ISIN, or a ticker on an exchange. A private one has
-- no identifier at all: it is not a listing, and an ISIN or a ticker would collide with the
-- shared catalog's unique indexes, so a 409 would tell one workspace what another one holds.
ALTER TABLE instruments DROP CONSTRAINT instruments_identifier_check;
ALTER TABLE instruments ADD CONSTRAINT instruments_identifier_check CHECK (
  CASE WHEN workspace_id IS NULL
    THEN isin IS NOT NULL OR ticker IS NOT NULL
    ELSE isin IS NULL AND ticker IS NULL AND exchange IS NULL
  END
);

-- GET /workspaces/:workspaceId/instruments lists a workspace's own instruments.
CREATE INDEX instruments_workspace_idx ON instruments (workspace_id, lower(name)) WHERE workspace_id IS NOT NULL;

-- Row-Level Security with one policy per command, as `prices` (migration 0034): every caller reads
-- the shared rows and its own workspace's, and inserts a shared row or one of its own workspace's.
-- `envelope_app` has no UPDATE or DELETE on this table (migration 0026), and with no policy for
-- them Row-Level Security would let neither touch a row anyway. A caller with no workspace (the
-- /instruments routes, which run on the pool with no session variables, or a system job) sees the
-- shared rows only: app_workspace_id() is null there, and `workspace_id = null` is never true.
ALTER TABLE instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments FORCE ROW LEVEL SECURITY;

CREATE POLICY instruments_select ON instruments FOR SELECT
  USING (workspace_id IS NULL OR workspace_id = app_workspace_id());

CREATE POLICY instruments_insert ON instruments FOR INSERT
  WITH CHECK (workspace_id IS NULL OR workspace_id = app_workspace_id());

-- A foreign key is checked without Row-Level Security (ADR 0006), so `prices.instrument_id` and
-- `trades.instrument_id` alone would accept the id of another workspace's private instrument. A
-- composite key cannot say "shared, or this row's own workspace's", so a trigger on each table
-- reads the instrument under the caller's own policies (not SECURITY DEFINER) and refuses the row
-- with a check_violation naming the constraint `instrument_not_found` when the instrument is not
-- one the row may point at:
--   * a workspace's price or trade: a shared instrument, or one of that same workspace's;
--   * a shared price: a shared instrument only, since every workspace reads a shared price.
-- The workspace comparison holds even for a caller that bypasses Row-Level Security (the table
-- owner correcting data by hand). search_path is pinned so the names below always resolve to these
-- tables.
CREATE OR REPLACE FUNCTION refuse_price_on_hidden_instrument() RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM instruments i
    WHERE i.id = NEW.instrument_id
      AND (i.workspace_id IS NULL OR i.workspace_id = NEW.workspace_id)
  ) THEN
    RAISE EXCEPTION 'the instrument is not found'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'instrument_not_found';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A trade without an instrument (a fee or a tax on the whole account) has nothing to check.
-- Fires on an INSERT and on an UPDATE of instrument_id; `workspace_id` is never updated
-- (migration 0031 grants no UPDATE on it).
CREATE FUNCTION refuse_trade_on_hidden_instrument() RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.instrument_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM instruments i
    WHERE i.id = NEW.instrument_id
      AND (i.workspace_id IS NULL OR i.workspace_id = NEW.workspace_id)
  ) THEN
    RAISE EXCEPTION 'the instrument is not found'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'instrument_not_found';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_refuse_hidden_instrument
  BEFORE INSERT OR UPDATE OF instrument_id ON trades
  FOR EACH ROW EXECUTE FUNCTION refuse_trade_on_hidden_instrument();
