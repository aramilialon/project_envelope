# 0012 — A trade owns its cash leg

- **Status:** accepted
- **Date:** 2026-11-20

## Context

A trade on a brokerage account moves two things: units of an instrument, and cash on the same account. A buy takes money out of the account, a sale or a dividend puts money in, a fee or a tax takes money out. The cash balance of a brokerage account is part of the household's money, so it must come out of the same `transactions` rows as every other account's balance (design.md, "Accounting rules": balances are recomputed from transactions), and a reconciliation of the account against the broker's statement must see it.

Recording the trade and, separately, a transaction for its cash would let the two disagree: edit the fees of a buy and forget the transaction, delete one and not the other, or have a device sync a new amount onto the transaction while the trade keeps the old one. The amounts of a trade are the broker's figures and the only source of truth; the cash is a consequence of them.

## Decision

- **Every cash-moving trade owns exactly one `transactions` row** on the trade's own account, its *cash leg*, with one split and no category. `transactions.trade_id` points at the trade with a composite foreign key `(workspace_id, trade_id) REFERENCES trades (workspace_id, id) ON DELETE CASCADE`, unique where not null: one leg per trade, and deleting the trade removes its leg. Splits and transfers of securities whose cash amount is zero have no leg; neither does any other trade whose amounts net to zero.
- **The leg is written in the same database transaction as the trade**, never later and never by a job, so a trade without its leg, or a leg without its trade, is never visible.
- **The leg's amount is derived from the trade** (positive = cash into the account), computed in `packages/core` (`tradeCashCents`):

  | Type | Cash |
  | --- | --- |
  | buy | −(gross + fees + transaction tax + accrued interest − domestic withholding) |
  | sell | gross + accrued interest − fees − transaction tax − gain tax − domestic withholding |
  | dividend (coupons too) | gross − fees − foreign withholding − domestic withholding |
  | fee | −fees |
  | tax | −gross; +gross for a `gain_tax_adjustment` (whose gross is signed: positive is a refund, negative extra tax) |
  | transfer of securities | −fees (no leg without fees) |
  | split | none |

  The domestic withholding is entered as a positive amount and the type gives its direction (`packages/core`'s `PositionTrade`): credited back on a bond buy with accrued interest, withheld on a sale or a dividend.
- **The leg starts uncleared** (`pending`), like any new transaction: the user marks it cleared when it appears on the broker's statement. Cash moves on the settlement date, usually two business days after the trade (T+2), so a statement dated inside that window does not include the trade yet: reconcile after settlement. A nullable settlement date on the trade can come later, if dating the leg on it turns out to be needed.
- **The leg's account, amount and date belong to the trade.** The leg is dated on the trade date, at midnight in the workspace's time zone, and lives on the trade's account: the foreign key `(workspace_id, trade_id, account_id) REFERENCES trades (workspace_id, id, account_id)` makes any other account impossible. The transactions API refuses to change its splits (and so its amount), or to delete it, with `trade_owned_transaction`; the transactions API has no way to change a transaction's account or date at all. Its memo, payee and cleared status stay the leg's own and are edited like any other transaction's.
- **They are never sync fields.** The field-level change protocol (design.md, "Offline sync and mobile") carries only the leg's own fields; `sync/apply.ts` refuses a change to `transactions.account_id`, `transactions.occurred_at` or a split's amount or category of a trade-owned transaction with the outcome `trade_owned`, before it looks at whether the field is wired at all, so wiring one later cannot open a way around this rule. A change to the trade itself is synced as a change to the trade, and the server rewrites the leg.
- **A reconciled leg locks its trade.** Once the leg is reconciled, the trade's amounts are part of a balance the user confirmed against a statement; editing or deleting the trade (#509) is refused until the reconciliation is unlocked, the same rule reconciled transactions follow.
- **The budget is not affected.** A brokerage account is always off budget (#74), so its legs never reach a category, and money reaches the account through an ordinary transfer from a budget account. A brokerage account's balance is the transfers into and out of it plus the sum of its cash legs.

## Client-generated ids

A trade may carry an id generated on the device, as offline sync needs. The primary key is global, so an id already used by a trade of another workspace is refused with 409 `id_taken`, like one of the same workspace. This is accepted: it needs a UUID the caller already knows, and reveals only that a trade with that id exists somewhere, nothing about it. The whole request is rolled back, both legs of a transfer included.

## Discarded alternatives

- **A separate cash ledger for brokerage accounts.** A second kind of balance, outside `transactions`, would need its own reconciliation, import and register, and the account's balance would no longer come from one place.
- **The trade with no transaction, the cash computed on the fly.** Reconciliation, import duplicate detection and the register all work on `transactions`; each would need a special case for brokerage accounts.
- **A transaction the user enters, linked to the trade.** The two could disagree as soon as either is edited; the broker's figures on the trade would no longer be the only source of truth.
- **A leg per amount (gross, fees, taxes as separate transactions).** Closer to some broker statements, but a reconciliation against a statement that shows one net amount per trade would need the user to add them up, and an edit would touch several rows.

## Consequences

- Creating, editing (#509) and deleting (#509) a trade write its leg too, in the same database transaction; the leg's amount is always `tradeCashCents` of the trade as stored.
- Every code path that changes a transaction's amount, account or date, or deletes a transaction, has to refuse a trade-owned one. Today that is `updateTransaction` (splits) and `deleteTransaction`; a later path (an import that merges into an existing row, a sync field) must do the same.
- A brokerage account's register shows the cash legs as ordinary transactions; the UI can show the trade behind each one through `tradeId`.
- An import of the broker's cash statement will find the legs as existing transactions and mark the matching rows as duplicates, as it does for any account.
