Changed

- `apps/api`: an account's transaction list comes one page at a time (`#560`): 100 transactions unless the request asks for up to 500 with `limit`,
  oldest first or newest first with `order`, and a `nextCursor` to ask for the next page, `null` on the last one. A client that read the whole
  list in one request now follows `nextCursor`; the web app's account register and balances do, so they still show every transaction.
