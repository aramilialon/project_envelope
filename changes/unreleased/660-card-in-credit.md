Fixed

- `@envelope/core`, `apps/api`, `apps/web`: a refund on a credit card after the card was paid left
  its payment category negative, and that was taken from next month's unassigned money as cash
  overspending, though the money is a credit on the card (`#660`). A payment category may now be
  negative down to its card's credit at the end of the month: only the part beyond the credit is
  cash overspending, the rest carries over and returns to zero as the credit is spent with the
  card. A card that owes −€10 with its payment category at −€50 now asks €40 to cover, not €50,
  and a card in credit with nothing beyond it is no longer reported as overspent. Its detail says the card is in
  credit by that amount, with nothing to cover, instead of "fully covered by money set aside", and
  shows "Credit on the card" in place of a negative card balance; a card that owes nothing says
  so.
