Changed

- `apps/web`: in a brokerage account's register and reconciliation, a trade's cash leg reads as
  its trade ("Buy · 10 × WEQ", "Dividend · WEQ", "Fee"), and opening it edits only its payee,
  memo and cleared status: its amount, date and kind change on the trade, and it cannot be
  deleted on its own. On an off-budget account, the transaction form, the import's check step and
  a reconciliation adjustment no longer ask for a category, and the reconciliation heading reads
  "Reconcile with your statement" for every account (`#657`, `#710`).
- `apps/api`: every transaction, and every reconciliation candidate, says which trade it is the
  cash leg of and what that trade is: its type, quantity and instrument (`#657`).
