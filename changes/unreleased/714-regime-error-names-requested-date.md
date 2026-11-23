Fixed

- `apps/api`, `packages/core`: adding a tax regime period before an account's first one that does
  not start on 1 January is refused naming the date asked for, not the stored first period's
  (`tax_regime_change_not_year_start`, `#714`).
