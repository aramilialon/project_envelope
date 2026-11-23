Fixed

- `@envelope/core`, `apps/api`, `apps/web`: an imported file's amounts are read in the account's
  currency, scaled by its own number of decimals (`#671`). A yen broker's "1000" is now ¥1,000,
  not ¥100,000, and a Kuwaiti dinar account's "1.500" is 1.500 dinars, not 0.150. Decimals beyond
  the currency's must be zeros: a file with any other ("1.250" in a yen account, "12.345" in a
  euro one) is refused whole with 400 `too_many_decimals` (`details` `{ decimals, currency }`)
  rather than rounded, since the amount was misread, and the import screen says how many
  decimals the account's currency allows, naming the decimal separator as a possible cause for a
  CSV file. A zero CSV outflow is 0, and an amount of a million digits is refused at once. This
  holds for CSV, OFX, QIF and CAMT.053 alike.
