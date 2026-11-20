-- The shared instruments catalog (#76; design.md, "Portfolio module" and "Data model":
-- "Shared across users; private data kept separate"). No workspace_id and no Row-Level
-- Security, the same reasoning as `users`: an instrument is public, non-personal data, and
-- every workspace's own holdings and trades (later migrations) point at the same row.
--
-- A row is a listing, not a security: one ISIN can trade on several exchanges, in different
-- currencies, so the same ISIN may appear once per exchange.
CREATE TABLE instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The API has already checked the check digit (@envelope/core's isValidIsin); the CHECK
  -- only guards the shape, upper case included.
  isin text CHECK (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  -- Ticker and exchange are stored upper-cased (@envelope/core's normalizeInstrument).
  ticker text CHECK (char_length(ticker) BETWEEN 1 AND 32 AND ticker = upper(ticker)),
  exchange text CHECK (char_length(exchange) BETWEEN 1 AND 32 AND exchange = upper(exchange)),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Split along the lines tax rules draw (fund, ETFs included, vs stock and etc_etn; government
  -- vs other bonds), since a row can never be updated later (@envelope/core's INSTRUMENT_TYPES).
  type text NOT NULL CHECK (type IN (
    'stock', 'fund', 'etc_etn', 'government_bond', 'bond', 'certificate', 'cash', 'other'
  )),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Free text: the allocation itself is the user's own tree (design.md, "Rebalancing engine"),
  -- and a mixed fund is split across its items by AllocationLink, not by this field.
  asset_class text CHECK (char_length(asset_class) BETWEEN 1 AND 64),
  -- amount = quantity × price × price_factor_e6 / 10^6, a scaled integer (ADR 0011): 1000000
  -- (a factor of 1) for most instruments, 10000 (0.01) for a bond quoted in percent of nominal
  -- (quantity = nominal) or an instrument quoted in pence.
  price_factor_e6 bigint NOT NULL DEFAULT 1000000 CHECK (price_factor_e6 > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Who added it, for a later administration task; never returned by the API, since the
  -- catalog is shared and a user id of another workspace is private data.
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- No private instruments in the shared catalog yet: every row is identified by an ISIN, or
  -- by a ticker on an exchange. A ticker always needs its exchange: on its own it is ambiguous.
  CONSTRAINT instruments_identifier_check CHECK (isin IS NOT NULL OR ticker IS NOT NULL),
  CONSTRAINT instruments_ticker_exchange_check CHECK (ticker IS NULL OR exchange IS NOT NULL)
);

-- One listing per ISIN and exchange; an ISIN with no exchange counts once too (NULLS NOT DISTINCT).
CREATE UNIQUE INDEX instruments_isin_exchange_key ON instruments (isin, exchange) NULLS NOT DISTINCT
  WHERE isin IS NOT NULL;
-- One listing per ticker and exchange, ignoring case (the columns are upper-cased already;
-- upper() keeps the rule if that normalization is ever relaxed).
CREATE UNIQUE INDEX instruments_ticker_exchange_key ON instruments (upper(ticker), upper(exchange))
  WHERE ticker IS NOT NULL;
-- Prefix search on ticker and name (instruments/repository.ts's searchInstruments).
CREATE INDEX instruments_ticker_prefix_idx ON instruments (upper(ticker) text_pattern_ops);
CREATE INDEX instruments_name_prefix_idx ON instruments (lower(name) text_pattern_ops);

-- Append-only for the app (#76's decision): an instrument other workspaces may already
-- reference cannot be altered or removed by one of them; corrections are an administration task.
GRANT SELECT, INSERT ON instruments TO envelope_app;
