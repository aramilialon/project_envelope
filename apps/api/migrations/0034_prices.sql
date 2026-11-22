-- Historical closing prices (#82, ADR 0019; design.md, "Portfolio module" and "Data model").
--
-- One table for two kinds of rows:
-- - a shared price (`workspace_id` null, `source = 'provider'`, `provider` names it): public data
--   fetched by a system job, the same for every workspace, like an instrument;
-- - a workspace's own price (`workspace_id` set, `source` 'manual' or 'csv', no `provider`): typed
--   or imported by a user, private to that workspace, never seen by another one.
-- Which price values an instrument on a date (the latest on or before it; the workspace's own
-- on a tie) is decided by @envelope/core's resolvePrice, not here: SQL only loads the candidates.
--
-- `close_e6` is quoted exactly like a trade's `price_e6` (ADR 0011): the price for one unit
-- × 10^6, in the instrument's currency, with the instrument's price factor applied on top.
-- A price is input data, edited in place; nothing computed from it is stored (ADR 0019).
CREATE TABLE prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
  instrument_id uuid NOT NULL REFERENCES instruments (id),
  price_date date NOT NULL,
  close_e6 bigint NOT NULL CHECK (close_e6 BETWEEN 0 AND 9007199254740991),
  source text NOT NULL CHECK (source IN ('manual', 'csv', 'provider')),
  provider text CHECK (char_length(provider) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- A shared row always comes from a provider, and a provider's row is always shared.
  CONSTRAINT prices_shared_source_check CHECK ((workspace_id IS NULL) = (source = 'provider')),
  CONSTRAINT prices_shared_provider_check CHECK ((provider IS NULL) = (workspace_id IS NOT NULL)),
  -- One shared price and one price per workspace for an instrument on a date (NULLS NOT DISTINCT:
  -- two shared rows for the same instrument and date are a duplicate too).
  CONSTRAINT prices_workspace_instrument_date_key UNIQUE NULLS NOT DISTINCT (workspace_id, instrument_id, price_date)
);

-- loadPriceCandidates and listPrices (prices/repository.ts): every row of an instrument up to a date.
CREATE INDEX prices_instrument_date_idx ON prices (instrument_id, price_date DESC);

-- Row-Level Security with one policy per command (ADR 0019, "Isolation of prices"). A single
-- policy whose USING clause allowed shared rows would let a request update or delete them as well:
-- USING decides which existing rows an UPDATE or DELETE may touch, not only which a SELECT sees.
-- Every caller reads shared rows and its own workspace's rows; it writes only its own workspace's
-- rows, and shared rows only inside a system job (app_is_system_job(), migration 0023, ADR 0010).
ALTER TABLE prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE prices FORCE ROW LEVEL SECURITY;

CREATE POLICY prices_select ON prices FOR SELECT
  USING (workspace_id IS NULL OR workspace_id = app_workspace_id());

CREATE POLICY prices_insert ON prices FOR INSERT
  WITH CHECK (
    workspace_id = app_workspace_id()
    OR (workspace_id IS NULL AND coalesce(app_is_system_job(), false))
  );

CREATE POLICY prices_update ON prices FOR UPDATE
  USING (
    workspace_id = app_workspace_id()
    OR (workspace_id IS NULL AND coalesce(app_is_system_job(), false))
  )
  WITH CHECK (
    workspace_id = app_workspace_id()
    OR (workspace_id IS NULL AND coalesce(app_is_system_job(), false))
  );

CREATE POLICY prices_delete ON prices FOR DELETE
  USING (
    workspace_id = app_workspace_id()
    OR (workspace_id IS NULL AND coalesce(app_is_system_job(), false))
  );

-- A foreign key is checked without Row-Level Security (ADR 0006), so `instrument_id` alone would
-- accept the id of an instrument the caller cannot see: once instruments can be private to a
-- workspace (#505), another workspace's. This trigger reads the instrument under the caller's own
-- policies (not SECURITY DEFINER) and refuses the row when it is not found, with a check_violation
-- naming the constraint `instrument_not_found`. Every instrument is shared until #505, which adds
-- the second rule: a shared price must point at a shared instrument. search_path is pinned so the
-- name below always resolves to this table.
CREATE FUNCTION refuse_price_on_hidden_instrument() RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM instruments WHERE id = NEW.instrument_id) THEN
    RAISE EXCEPTION 'the instrument is not found'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'instrument_not_found';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prices_refuse_hidden_instrument
  BEFORE INSERT OR UPDATE ON prices
  FOR EACH ROW EXECUTE FUNCTION refuse_price_on_hidden_instrument();

-- UPDATE only on what an edit changes: the close, its source (a manual price replaced by a CSV
-- import, or back) and the time of the change. A row never moves to another workspace,
-- instrument or date, and never turns from a workspace's price into a shared one.
GRANT SELECT, INSERT, DELETE ON prices TO envelope_app;
GRANT UPDATE (close_e6, source, updated_at) ON prices TO envelope_app;
