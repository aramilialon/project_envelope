Fixed

- `apps/web`: the reconciliation's "As of" date starts on today in the workspace's time zone, not the
  browser's, so near midnight today's transactions are no longer left out; a date you change stays as
  you set it. Dates in the budget's "To do" list and the transaction form's hints show their year by
  the workspace's current year (`#814`).
