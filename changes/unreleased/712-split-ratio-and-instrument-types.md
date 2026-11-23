Fixed

- `apps/api`, `packages/core`: a split whose two figures are equal (1:1, 2:2), which changes nothing,
  is refused with 400 `invalid_trade` naming `splitTo`, with the other ratio checks and before any
  tax regime check. Splits stored with equal figures are deleted by migration 0041, which changes no
  position, cost or amount. A refused instrument type lists the accepted ones in `details.allowed`
  (`#712`).
