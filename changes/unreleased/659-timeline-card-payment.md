Fixed

- `apps/api`, `packages/core`: the budget month's "day by day" timeline counts a card purchase once, on the
  day it was made; paying the card from a checking account, moving money between two on-budget accounts and
  moving debt between two cards no longer move the line, and money moved to or from an off-budget account
  counts once (`#659`).
