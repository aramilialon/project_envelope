# 0008 — Monthly assignments as an append-only ledger, not mutable totals

- **Status:** accepted
- **Date:** 2026-09-26

## Context

`monthly_assignments` (migration `0007`) stores one mutable row per (category, month): a single `assigned_cents` total, upserted whenever the user assigns, unassigns or moves money. Offline sync (design.md, "Offline sync and mobile") resolves conflicts field by field, by clock, last write wins.

A single mutable total is exactly the shape that protocol handles badly: two devices offline at the same time, each moving money into the same category for the same month, produce two changes to the *same field*. Last-write-wins keeps only one of them — the other is silently lost, with no conflict for the user to even notice, because from the server's point of view nothing looked wrong: one plausible number replaced another.

## Decision

- Replace the mutable total with an append-only ledger. Each row is immutable: `id`, `batch_id`, `workspace_id`, `month`, `source_category_id` (nullable — `NULL` means unassigned money), `destination_category_id` (nullable, same meaning), `amount_cents`, `author` (the user), `created_at`.
  - **Assign** money to a category: `NULL → category`.
  - **Unassign** (take money out): `category → NULL`.
  - **Move** money between two categories: one row, `A → B` — never two separate assign/unassign rows, so it reads as one action in the ledger and can be undone as one.
- **`batch_id`, a UUID generated on the device, same as `id`.** Every row created by one user action shares it: a single assign/unassign/move gets a batch of one; quick assign or "fund all targets" produce one row per category, all sharing the same `batch_id`, so the whole group undoes together. Being device-generated (not server-assigned) is what makes this work offline, the same reason row ids are UUIDs (design.md, "Accounting rules").
- A category's assigned amount in a month is derived, never stored: `SUM(amount WHERE destination = category AND month = month) − SUM(amount WHERE source = category AND month = month)`. This is exactly the `Assignment` shape `packages/core`'s `computeBudgetMonth` already takes (one aggregated number per category per month) — the core does not change.
- **Undo is new rows, never an edit or a delete.** Undoing a batch reverses every one of its rows (source and destination swapped, same amount), each new row setting `reverses` to the original row's id, and all of them sharing one new common `batch_id` of their own (the undo is itself one action, undoable as a whole in principle, though the interface does not expose undoing an undo). `reverses` is unique where not null, so a row can be undone at most once — the UI hides the undo action once every row of a batch already has a reverser.
- **Index on `(workspace_id, month)`**, since every read aggregates by workspace and month; **index on `batch_id`**, since undoing a batch looks up every row that shares it.
- **No separate totals table for now.** If aggregating the ledger on every read turns out too slow, the fix is a derived table (rebuildable from the ledger, not itself synced or written directly by clients) — not a return to mutable per-category rows.

## Consequences

- Two offline moves to the same category in the same month never conflict: both rows land, both are counted, nothing is lost. This is the entire point.
- Every assignment change carries its own author and timestamp for free — no separate audit trail needed for "who assigned what."
- A new migration replaces `monthly_assignments`'s columns (never editing the already-applied `0007`); no real deployment has assignment data yet, so there is nothing to migrate beyond any local test data.
- Reading "what is category X assigned this month" is always an aggregation query, never a single-row lookup; the `(workspace_id, month)` index keeps this cheap at the scale this product runs at.
- "Undo this whole quick assign" needs no separate batch table or extra bookkeeping: it is a query for `batch_id`, then one reversing row per result.
