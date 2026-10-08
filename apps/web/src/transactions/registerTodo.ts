/**
 * The account register's own "To do" list (#337, design.md "Account register"): three actions
 * specific to this screen, not the budget month's own list (`@envelope/core`'s `computeTodos`) —
 * record an overdue scheduled transaction, mark a pending one as cleared, reconcile once there
 * are cleared transactions to fold in. Plain derived view data, not a `packages/core` function:
 * unlike `computeTodos`, nothing here is a calculation — each item is already-fetched data,
 * filtered and reshaped, the same way `BudgetScreen.tsx`'s own `scheduledByCategoryThisMonth` is.
 */
export type RegisterTodoItem =
  | { readonly kind: "recordOverdue"; readonly scheduledTransactionId: string; readonly payee: string; readonly date: string; readonly amountCents: number }
  | { readonly kind: "markPending"; readonly transactionId: string; readonly payee: string; readonly date: string; readonly amountCents: number }
  | { readonly kind: "reconcile"; readonly clearedCount: number; readonly clearedCents: number };
