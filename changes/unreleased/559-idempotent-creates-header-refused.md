Changed

- `apps/api`: an `Idempotency-Key` header on a write request that does not take it is refused with `400 invalid_field`, so a client never believes a create was protected when it was not (`#559`).
