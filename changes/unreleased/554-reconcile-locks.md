Fixed

- `apps/api`: reconciling an account at the same moment as an edit, a delete, an import or a synced change of one of its
  ticked transactions no longer leaves the transaction reconciled with a date or an amount the
  reconciliation did not count, nor unlocks it again: whichever comes second waits for the first and then
  sees what it wrote (`#554`).
