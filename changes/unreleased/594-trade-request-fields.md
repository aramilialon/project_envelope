Changed

- `apps/api`: a trade request takes only its own fields: a field of another kind of request
  (`from` on a buy, `accountId` on a transfer or a split, `gainTaxCents` on a buy) is refused with
  `invalid_trade` naming it, on create and edit, instead of being ignored; every body the trade
  routes cannot read now answers with a code (`invalid_body`, `unknown_field`, `invalid_field`)
  instead of an English sentence (`#594`).
- `apps/api`: a buy or a sale needs its price and a dividend its gross; a buy at a price of 0 and
  a dividend of 0 are refused, while a sale at a price of 0 closes a worthless position as a
  realized loss. A trade stored before at a price of 0 still takes edits that leave its quantity,
  price and gross alone (`#600`).
- `apps/api`: trade errors name the field actually wrong, in a fixed order (a negative quantity is
  refused for its quantity, not for the gross computed from it); an error's `tradeId` is `null` for
  the trade being recorded instead of an id no trade has, and a position whose quantity would leave
  the safe range names the trade that pushes it over (`#662`).
