Fixed

- `apps/api`, `packages/core`: the budget month's "day by day" timeline counts a card purchase once, on the
  day it was made: paying the card from a checking account no longer moves the line a second time, and
  moving debt between two cards no longer shows as two movements (`#659`).
