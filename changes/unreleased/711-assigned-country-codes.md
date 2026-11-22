Fixed

- `apps/api`, `packages/core`: a workspace's tax country accepted codes that name no country, such
  as `ZZ`, `EU`, `UN` or `UK`; it now takes only an officially assigned ISO 3166-1 code, and answers
  400 `invalid_tax_country` otherwise. A code stored before is still read back, and
  `scripts/dev/find-unassigned-tax-countries.sql` lists the workspaces holding one (`#711`).
