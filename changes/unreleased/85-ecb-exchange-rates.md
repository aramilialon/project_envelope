Added

- `apps/api`: the euro exchange rates the European Central Bank publishes every working day
  (`#85`, `#84`). The server downloads the public rates file at startup (unless the stored rates
  are from today or yesterday) and twice every working day, the full history the first time, and
  keeps every currency still in use; `GET /fx-rates` returns a
  currency's rates. The request carries nothing about the server or its users; set
  `MARKET_DATA_FETCH_ENABLED=false` to make no outbound request at all and load a downloaded file
  with `pnpm --filter @envelope/api fx-rates:import <file>` instead. Prices still come only from
  what you enter (`MARKET_DATA_PRICE_PROVIDER=manual`, the only provider so far).
