Fixed

- `apps/api`: in an `IT` workspace, an edit that moves a trade, a transfer's leg or a split's row
  into a brokerage account with no tax regime is refused with `tax_regime_required`, as a new trade
  there is (`#680`).
