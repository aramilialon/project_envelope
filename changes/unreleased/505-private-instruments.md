Added

- `apps/api`: private instruments (`#505`). A workspace can add an asset with no ISIN and no
  ticker (real estate, a company pension fund, private company shares) with only a name, type,
  currency and asset class: `POST /workspaces/:workspaceId/instruments`, listed by
  `GET /workspaces/:workspaceId/instruments`. Only that workspace sees it, trades it and records
  prices for it; the shared `/instruments` catalog never shows it. Its name is unique in the
  workspace, ignoring case. Every instrument row now carries `workspaceId` (`null` for the shared
  catalog).
