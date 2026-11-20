-- Trades (#77; design.md, "Portfolio module" and "Data model"; ADR 0011 and ADR 0012).
--
-- A position is never stored: @envelope/core's computePositions rebuilds it by replaying these rows
-- in the order (trade_date, split first, occurred_at, created_at, id). Every amount is in the
-- account's minor unit (ADR 0002); quantity_e8 and price_e6 are scaled integers (ADR 0011), the
-- price in the instrument's quoting. A column a type does not use is 0 (amounts, quantity, price)
-- or null (tax_kind, cost_basis_cents, split_from, split_to, transfer_trade_id), as
-- @envelope/core's PositionTrade expects; one CHECK per type below enforces it.
CREATE TABLE trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  -- The shared catalog (migration 0026, no workspace_id): a single-column key. Null only for a fee
  -- or a tax charged on the whole account (custody, stamp duty).
  instrument_id uuid REFERENCES instruments (id),
  type text NOT NULL CHECK (type IN ('buy', 'sell', 'dividend', 'fee', 'tax', 'split', 'transfer')),
  -- The trade date on the broker's statement; a split's is its ex-date.
  trade_date date NOT NULL,
  -- Only orders trades within one trade_date; null when the time is not known.
  occurred_at timestamptz,
  -- Units × 10^8. Positive on a buy and a sell; on a transfer, negative on the outgoing leg and
  -- positive on the incoming one.
  quantity_e8 bigint NOT NULL DEFAULT 0,
  price_e6 bigint NOT NULL DEFAULT 0,
  -- Buy and sell: the amount of the units (quantity × price × price factor unless the broker
  -- charged otherwise); dividend: the gross income; tax: the tax amount.
  gross_cents bigint NOT NULL DEFAULT 0,
  fees_cents bigint NOT NULL DEFAULT 0,
  -- The financial transaction tax and similar.
  transaction_tax_cents bigint NOT NULL DEFAULT 0,
  -- Bonds only (the API checks the instrument's type).
  accrued_interest_cents bigint NOT NULL DEFAULT 0,
  withholding_foreign_cents bigint NOT NULL DEFAULT 0,
  -- Entered as a positive amount; the type gives the direction: credited back on a bond buy with
  -- accrued interest, withheld on a sale or a dividend.
  withholding_domestic_cents bigint NOT NULL DEFAULT 0,
  -- Sell only: the gain tax the broker withheld.
  gain_tax_cents bigint NOT NULL DEFAULT 0,
  tax_kind text CHECK (tax_kind IN ('stamp_duty', 'managed_result_tax', 'gain_tax_adjustment', 'other')),
  -- Only on a transfer in from outside the app (an incoming leg with no outgoing one): the cost the
  -- units bring. Between two accounts of the app the replay carries the outgoing leg's cost.
  cost_basis_cents bigint,
  -- A split's ratio, from:to (1:4 means 1 unit becomes 4).
  split_from bigint,
  split_to bigint,
  -- The other leg of a transfer; null for a transfer from or to outside the app.
  transfer_trade_id uuid,
  memo text CHECK (char_length(memo) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- For the composite foreign keys pointing here (the other leg of a transfer, a cash leg).
  CONSTRAINT trades_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT trades_account_id_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  -- A portfolio with trades cannot be deleted: the portfolios route answers 409
  -- `portfolio_has_trades`.
  CONSTRAINT trades_portfolio_id_fkey FOREIGN KEY (workspace_id, portfolio_id)
    REFERENCES portfolios (workspace_id, id) ON DELETE RESTRICT,
  -- Deferrable so the two legs of a transfer can be inserted already pointing at each other
  -- (SET CONSTRAINTS ... DEFERRED, then IMMEDIATE before the request ends); NO ACTION, so only both
  -- legs together can be deleted.
  CONSTRAINT trades_transfer_trade_id_fkey FOREIGN KEY (workspace_id, transfer_trade_id)
    REFERENCES trades (workspace_id, id) MATCH SIMPLE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT trades_transfer_trade_id_not_self_check CHECK (transfer_trade_id <> id),

  -- Within the safe-integer range of a JavaScript number (ADR 0011): every value read back is
  -- exact. A price is never negative.
  CONSTRAINT trades_quantity_e8_range_check CHECK (quantity_e8 BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT trades_price_e6_range_check CHECK (price_e6 BETWEEN 0 AND 9007199254740991),
  CONSTRAINT trades_split_ratio_range_check CHECK (split_from <= 9007199254740991 AND split_to <= 9007199254740991),
  -- Amounts are never negative, except the gross of a gain tax adjustment (positive = refund,
  -- negative = extra tax).
  CONSTRAINT trades_amounts_not_negative_check CHECK (
    fees_cents >= 0 AND transaction_tax_cents >= 0 AND accrued_interest_cents >= 0
    AND withholding_foreign_cents >= 0 AND withholding_domestic_cents >= 0 AND gain_tax_cents >= 0
    AND (gross_cents >= 0 OR tax_kind IS NOT DISTINCT FROM 'gain_tax_adjustment')
    AND (cost_basis_cents IS NULL OR cost_basis_cents >= 0)
  ),

  -- One CHECK per type: what it requires and what it forbids. A CHECK passes when it is null, so
  -- every comparison with a nullable column is guarded by IS NOT NULL.
  CONSTRAINT trades_buy_check CHECK (type <> 'buy' OR (
    instrument_id IS NOT NULL AND quantity_e8 > 0
    AND withholding_foreign_cents = 0 AND gain_tax_cents = 0
    AND (withholding_domestic_cents = 0 OR accrued_interest_cents > 0)
    AND tax_kind IS NULL AND cost_basis_cents IS NULL AND split_from IS NULL AND split_to IS NULL
    AND transfer_trade_id IS NULL
  )),
  CONSTRAINT trades_sell_check CHECK (type <> 'sell' OR (
    instrument_id IS NOT NULL AND quantity_e8 > 0
    AND withholding_foreign_cents = 0
    AND (withholding_domestic_cents = 0 OR accrued_interest_cents > 0)
    AND tax_kind IS NULL AND cost_basis_cents IS NULL AND split_from IS NULL AND split_to IS NULL
    AND transfer_trade_id IS NULL
  )),
  CONSTRAINT trades_dividend_check CHECK (type <> 'dividend' OR (
    instrument_id IS NOT NULL AND quantity_e8 = 0 AND price_e6 = 0
    AND transaction_tax_cents = 0 AND accrued_interest_cents = 0 AND gain_tax_cents = 0
    AND tax_kind IS NULL AND cost_basis_cents IS NULL AND split_from IS NULL AND split_to IS NULL
    AND transfer_trade_id IS NULL
  )),
  CONSTRAINT trades_fee_check CHECK (type <> 'fee' OR (
    quantity_e8 = 0 AND price_e6 = 0 AND gross_cents = 0
    AND transaction_tax_cents = 0 AND accrued_interest_cents = 0 AND withholding_foreign_cents = 0
    AND withholding_domestic_cents = 0 AND gain_tax_cents = 0
    AND tax_kind IS NULL AND cost_basis_cents IS NULL AND split_from IS NULL AND split_to IS NULL
    AND transfer_trade_id IS NULL
  )),
  CONSTRAINT trades_tax_check CHECK (type <> 'tax' OR (
    tax_kind IS NOT NULL AND quantity_e8 = 0 AND price_e6 = 0 AND fees_cents = 0
    AND transaction_tax_cents = 0 AND accrued_interest_cents = 0 AND withholding_foreign_cents = 0
    AND withholding_domestic_cents = 0 AND gain_tax_cents = 0
    AND cost_basis_cents IS NULL AND split_from IS NULL AND split_to IS NULL
    AND transfer_trade_id IS NULL
  )),
  CONSTRAINT trades_split_check CHECK (type <> 'split' OR (
    instrument_id IS NOT NULL AND split_from IS NOT NULL AND split_to IS NOT NULL AND split_from > 0 AND split_to > 0
    AND quantity_e8 = 0 AND price_e6 = 0 AND gross_cents = 0 AND fees_cents = 0
    AND transaction_tax_cents = 0 AND accrued_interest_cents = 0 AND withholding_foreign_cents = 0
    AND withholding_domestic_cents = 0 AND gain_tax_cents = 0
    AND tax_kind IS NULL AND cost_basis_cents IS NULL AND transfer_trade_id IS NULL
  )),
  -- A transfer moves units (signed) and may carry fees. Only an incoming leg with no outgoing one
  -- (a transfer in from outside the app) carries a cost, and it must.
  CONSTRAINT trades_transfer_check CHECK (type <> 'transfer' OR (
    instrument_id IS NOT NULL AND quantity_e8 <> 0 AND price_e6 = 0 AND gross_cents = 0
    AND transaction_tax_cents = 0 AND accrued_interest_cents = 0 AND withholding_foreign_cents = 0
    AND withholding_domestic_cents = 0 AND gain_tax_cents = 0
    AND tax_kind IS NULL AND split_from IS NULL AND split_to IS NULL
    AND (cost_basis_cents IS NOT NULL) = (transfer_trade_id IS NULL AND quantity_e8 > 0)
  ))
);

CREATE INDEX trades_workspace_id_idx ON trades (workspace_id);
-- The replay reads the workspace's whole history of one instrument.
CREATE INDEX trades_workspace_instrument_idx ON trades (workspace_id, instrument_id);
CREATE INDEX trades_account_id_idx ON trades (workspace_id, account_id);
CREATE INDEX trades_portfolio_id_idx ON trades (workspace_id, portfolio_id);
-- A leg links to one other leg only.
CREATE UNIQUE INDEX trades_transfer_trade_id_key ON trades (transfer_trade_id) WHERE transfer_trade_id IS NOT NULL;

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON trades
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- UPDATE and DELETE are for editing and deleting a trade (#509).
GRANT SELECT, INSERT, UPDATE, DELETE ON trades TO envelope_app;

-- The cash leg (ADR 0012): the one transaction a cash-moving trade owns, on the same account, with
-- one split and no category. Its amount, account and date are derived from the trade; deleting the
-- trade deletes it.
ALTER TABLE transactions ADD COLUMN trade_id uuid;
ALTER TABLE transactions ADD CONSTRAINT transactions_trade_id_fkey FOREIGN KEY (workspace_id, trade_id)
  REFERENCES trades (workspace_id, id) MATCH SIMPLE ON DELETE CASCADE;
CREATE UNIQUE INDEX transactions_trade_id_key ON transactions (trade_id) WHERE trade_id IS NOT NULL;
