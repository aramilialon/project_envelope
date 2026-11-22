Fixed

- `apps/api`: a credit card's starting balance comes first on the day the card is added (`#706`). It was stored at the moment the card was created, so a purchase dated that same day was listed before it, and the register's running balance for that purchase ran as if the card owed nothing yet. A new starting balance is now dated at midnight of that day in the workspace's time zone; migration 0037 moves the starting balances recorded before, keeping their day, so no balance, month or total changes.
