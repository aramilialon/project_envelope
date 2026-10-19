/**
 * The account register's own "To do" list (#337, design.md "Account register"): two actions
 * specific to this screen, not the budget month's own list (`@envelope/core`'s `computeTodos`) —
 * record an overdue scheduled transaction, mark a pending one as cleared. Plain derived view
 * data, not a `packages/core` function:
 * unlike `computeTodos`, nothing here is a calculation — each item is already-fetched data,
 * filtered and reshaped, the same way `BudgetScreen.tsx`'s own `scheduledByCategoryThisMonth` is.
 *
 * Reconciling (opens `ReconciliationScreen`, `#60`) used to be a third item here, appearing the
 * moment any single transaction was cleared — nagging after one import, or one manually-ticked
 * "cleared" checkbox, long before there was anything worth checking (`#404`). There is no
 * threshold that fixes this: the account's own running balance already tells the truth, so
 * reconciling is a manual action the person reaches for themselves when they notice it looks
 * wrong, not something this list should keep suggesting — it lives in the toolbar instead,
 * always there, never a "thing to do".
 */
export type RegisterTodoItem =
  | { readonly kind: "recordOverdue"; readonly scheduledTransactionId: string; readonly payee: string; readonly date: string; readonly amountCents: number }
  | { readonly kind: "markPending"; readonly transactionId: string; readonly payee: string; readonly date: string; readonly amountCents: number };
