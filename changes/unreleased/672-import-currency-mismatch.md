Fixed

- `@envelope/core`, `apps/api`, `apps/web`: an OFX or CAMT.053 file that states another currency
  than the account's (OFX's `CURDEF` or a transaction's own `CURRENCY`, CAMT.053's statement
  account or an entry's amount) is refused whole with 400 `currency_mismatch` and `details`
  `{ fileCurrency, accountCurrency }`, and nothing of it is staged (`#672`); a dollar statement no
  longer goes into a euro account as euros. The import screen names both currencies ("US Dollar
  (USD)", "Euro (EUR)"); a stated currency that is not a three-letter code is refused all the
  same, without being named back. An OFX transaction's `ORIGCURRENCY` is not read and its
  `CURRATE` never applied. CSV and QIF files state no currency and are read in the account's,
  as before.
