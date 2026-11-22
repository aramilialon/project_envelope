-- Euro reference exchange rates (#85, ADR 0019; design.md, "Market data").
--
-- One row per currency and day, as the European Central Bank publishes it: `rate_e10` is the
-- units of `quote_currency` for one euro × 10^10 (USD 1.0812 is 10812000000), never inverted and
-- never stored for another pair; @envelope/core converts every other pair through the euro.
-- Within the safe-integer range, so node-postgres and JavaScript read it exactly (ADR 0011).
--
-- Public data, the same for every workspace: no `workspace_id`. Every caller reads it; only a
-- system job writes it (app_is_system_job(), migration 0023, ADR 0010), so no request, whatever
-- its workspace or role, can change a rate.
CREATE TABLE fx_rates (
  base_currency text NOT NULL CHECK (base_currency = 'EUR'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$' AND quote_currency <> base_currency),
  rate_date date NOT NULL,
  rate_e10 bigint NOT NULL CHECK (rate_e10 BETWEEN 1 AND 9007199254740991),
  -- Where the rate came from: 'ecb' (fetched, or loaded from a downloaded ECB file).
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 64),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_currency, quote_currency, rate_date)
);

ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates FORCE ROW LEVEL SECURITY;

CREATE POLICY fx_rates_select ON fx_rates FOR SELECT
  USING (true);

CREATE POLICY fx_rates_insert ON fx_rates FOR INSERT
  WITH CHECK (coalesce(app_is_system_job(), false));

CREATE POLICY fx_rates_update ON fx_rates FOR UPDATE
  USING (coalesce(app_is_system_job(), false))
  WITH CHECK (coalesce(app_is_system_job(), false));

-- No DELETE: a rate the ECB stops publishing stays, and a corrected one is updated in place.
-- UPDATE only on what a newer publication changes.
GRANT SELECT, INSERT ON fx_rates TO envelope_app;
GRANT UPDATE (rate_e10, source, fetched_at) ON fx_rates TO envelope_app;
