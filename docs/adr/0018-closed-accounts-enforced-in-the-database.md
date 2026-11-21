# 0018 — A closed account takes no writes, enforced in the database

- **Status:** accepted
- **Date:** 2026-11-21

## Context

An account is closed, never deleted: its rows stay in every month they fall in. #703 refused to close an account whose balance over all dates was not zero, or that still held securities. The 0.2.0 verification run found two problems with that (#729):

- The rule read the balance over all dates, while every screen shows the balance as of today (#702). An account showing €10 today closed when a row dated later cancelled it, and the €10 left net worth; an account at €0 today with −€10 later was refused, quoting −€10, a figure the user could not see anywhere. A brokerage account holding a unit today and selling it at a later date could close.
- A closed account still took every write: transactions, transfers into and out of it, trades, imports, scheduled transactions, reconciliations. A transfer into a closed account took money out of net worth, so the close rule meant little.

Writes to an account reach the database from many places: the transactions, transfers, trades, import, reconciliation and scheduled-transactions routes, the job that records due scheduled transactions, and sync changes; editing one leg of a transfer, or one trade, also writes to the other leg's account. A check in each of them would be easy to miss in the next write path, and each would have to lock the account against a concurrent close in the same way.

## Decision

- **The close rule reads today.** An account closes only when it is empty today and later, "today" in the workspace's time zone: its balance today is zero and no transaction is dated after today; it holds no security today and no trade is dated after today; and no scheduled transaction uses it (a schedule would keep writing to it). The refusal, 409 `account_not_empty`, carries `balanceCents` (today's balance, the figure on screen), `laterRows { count, firstDate }`, `holdsPositions` and `scheduled { count }`, so the web app names every reason with figures the user can see.
- **The database refuses every write to a closed account.** Migration 0033 adds one trigger function, `refuse_closed_account_write()`, run `BEFORE INSERT OR UPDATE OR DELETE` on `transactions`, `splits` (through the split's transaction), `trades` and `scheduled_transactions`, and `BEFORE INSERT` on `reconciliations`. It reads every account the row was and is on, and raises a `check_violation` naming the constraint `account_closed` when one is closed, the same pattern as migration 0028's tax-regime rules. `toErrorReply` answers it 409 `{ error: "account_closed" }` on every route, so a route needs no check of its own to be safe.
- **The trigger and the close serialise on the account row.** The trigger locks each account `FOR KEY SHARE` before reading `closed_at`; the close locks it `FOR UPDATE`, which conflicts. A write that locked first finishes before the close checks what the account holds, and one that comes after the close sees it closed. `FOR KEY SHARE` conflicts neither with itself nor with an update that leaves the key alone, so writes to the same open account do not wait for one another. Every account is locked before `closed_at` is read: a `WHERE closed_at IS NOT NULL` would leave an open account unlocked, and a close could slip in.
- **Only a statement's own writes are checked.** An `UPDATE` or `DELETE` fired by a foreign key's action (`pg_trigger_depth() > 1`: a cascade, a `SET NULL`, the cash leg following its trade) passes. It comes from a write that was itself checked, or from deleting a workspace, which must remove everything in it, closed accounts included. Every `INSERT` is checked; no foreign key action inserts.
- **Not `SECURITY DEFINER`, and no change to Row-Level Security.** The trigger reads the account under the caller's own policies: an account of another workspace is not found there, and the foreign key or the policy refuses the row as before.
- **Where the error would hurt, it is avoided, not caught.** The job that records due scheduled transactions skips schedules on closed accounts, so one closed account does not end the run for every workspace. A sync change to a closed account's transaction answers `account_closed` on its own, read `FOR KEY SHARE` as the trigger does, and the rest of the upload still applies. Staging an import into a closed account is refused up front with 409 `account_closed`, before the file is read. The web app offers no closed account as a transfer's other account.

## Alternatives considered

- **A check in each repository or route.** Every write path would need its own lock and check, and the next one added could forget both; the database is the one place every write passes through, the job and sync included.
- **A Row-Level Security policy on the account's state.** Policies decide which rows a role sees, not whether an account is open; a policy reading `accounts` from each guarded table would run on every read as well, and its refusal (42501) would be answered 403, a permission error rather than a conflict with the account's state.
- **A foreign key to open accounts only** (a partial unique index on open accounts). A foreign key cannot reference a partial index, and closing an account with rows would then have to break the rows' own references.
- **The balance over all dates, as before.** It quotes figures no screen shows, and lets a row dated later empty or fill an account the user sees as the opposite.

## Consequences

- Every write to a closed account is refused, memo and cleared edits included, until reopening exists. Reopening an account, the confirmation before closing and edits that change nothing the account holds (a memo, the cleared status) are left to #705.
- An import confirmation that touches a closed account (a row of it, or a transfer to it) is refused as a whole, not row by row: the database error ends the request's transaction.
- A schedule on an account closed before this rule (data from before #729) stays due and unrecorded; it can only be deleted once the account reopens. Closing an account with a schedule is now refused, so no new case arises.
- A table added later whose rows belong to an account needs the same trigger.
