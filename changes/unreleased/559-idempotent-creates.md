Added

- `apps/api`: creating a transaction, a transfer or an assignment batch, quick assign, recording a scheduled transaction and undoing an assignment take an optional `Idempotency-Key` header (a UUID); a request sent again under the same key is recorded once and gets the first reply (`Idempotent-Replayed: true`), another request under a used key is refused with `409 id_conflict`, and keys are kept 24 hours (`#559`, ADR 0020).
- `apps/api`: assignment batches and quick assign take an optional client `batchId`, unique per workspace: the same batch sent twice is assigned once (`#559`).
- `apps/web`: saving a transaction or a transfer sends an `Idempotency-Key`, and every assignment carries a `batchId` (`#559`).
