Fixed

- `apps/api`, `packages/core`: a new instrument accepted any three letters as its currency (`XYZ`),
  though no account could ever trade it; it now takes only an ISO 4217 code in use, the same check
  as an account's, and answers 400 `invalid_currency` otherwise (`#595`).
