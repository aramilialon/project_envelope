Fixed

- `@envelope/core`, `apps/api`: an imported file's amounts are read in the account's currency, scaled by its own number of decimals (`#671`). A yen broker's "1000" is now ¥1,000, not ¥100,000, and a Kuwaiti dinar account's "1.500" is 1.500 dinars, not 0.150; decimals beyond the currency's are rounded half away from zero to its minor unit, exactly. This holds for CSV, OFX, QIF and CAMT.053 alike.
