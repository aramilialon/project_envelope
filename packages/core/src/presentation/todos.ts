import type { CategoryMonth } from "../budget/budget-month.ts";
import type { Cents } from "../money.ts";

/**
 * The budget month's own "To do" list (design.md, "Budget month on the desktop" — "To do";
 * `docs/ux/mockups/budget-month.html`'s own `todos`, the literal reference this mirrors): what
 * needs attention this month, each with its own amount and, implicitly, one action — a typed
 * list out, never literal text (no user-facing text in `packages/core`); `apps/web`'s `Todo.tsx`
 * composes the sentence per `kind` via FormatJS/ICU and wires up the action.
 *
 * Not this module's job: the account register's own "To do" (Record/Mark/Reconcile) — a
 * different, unrelated set of actions, tracked in `#337`.
 */

export type TodoItem =
  | { readonly kind: "overassigned"; readonly amountCents: Cents }
  | { readonly kind: "cashOverspending"; readonly categoryId: string; readonly amountCents: Cents }
  | { readonly kind: "cardOverspending"; readonly categoryId: string; readonly amountCents: Cents }
  | {
      readonly kind: "scheduledOverdue";
      readonly scheduledTransactionId: string;
      readonly categoryId: string;
      /** The scheduled transaction's own stored payee — raw data, never composed UI text. */
      readonly payee: string;
      /** Its own due date (`YYYY-MM-DD`) — raw data; the UI formats it with `Intl.DateTimeFormat`. */
      readonly date: string;
      readonly amountCents: Cents;
    }
  | { readonly kind: "reservationShortfall"; readonly categoryId: string; readonly amountCents: Cents }
  | { readonly kind: "cardDebtUncovered"; readonly categoryId: string; readonly amountCents: Cents }
  | { readonly kind: "targetsNeeded"; readonly categoryIds: readonly string[]; readonly amountCents: Cents };

/** A scheduled transaction due in the month and not recorded yet, overdue as of today — the caller's own call, since `packages/core` never reads the clock. */
export interface OverdueScheduledItem {
  readonly scheduledTransactionId: string;
  readonly categoryId: string;
  readonly payee: string;
  /** Its own due date (`YYYY-MM-DD`). */
  readonly date: string;
  /** Always positive: the expense's own amount, not yet spent. */
  readonly amountCents: Cents;
}

/** A category whose target still asks for money this month (`computeTarget`'s own `missing`, already > 0). */
export interface CategoryTargetNeed {
  readonly categoryId: string;
  readonly missingCents: Cents;
}

export interface TodosInput {
  /** `BudgetMonth.unassigned` — negative means more was assigned than there is money for. */
  readonly unassignedCents: Cents;
  /** Ordinary categories only, not payment categories (passed separately, below). */
  readonly categories: readonly CategoryMonth[];
  /** Credit cards' own payment categories. */
  readonly paymentCategories: readonly CategoryMonth[];
  readonly overdueScheduledItems: readonly OverdueScheduledItem[];
  readonly targetsNeeded: readonly CategoryTargetNeed[];
}

/**
 * How much of a category's own reservation (`CategoryMonth.reserved`) its current balance cannot
 * cover — the same figure `docs/ux/mockups/budget-month.html`'s own `compute()` calls `short`.
 * `CategoryMonth.available` is already net of `reserved` (rule 7, `budget-month.ts`), so the
 * balance before that subtraction is recovered as `available + reserved`.
 */
function reservationShortfall(category: CategoryMonth): Cents {
  if (category.reserved <= 0) return 0;
  const beforeReservation = category.available + category.reserved;
  return Math.max(0, Math.min(category.reserved, category.reserved - Math.max(0, beforeReservation)));
}

/**
 * How much money a category still needs to stop being a problem — the same figure "Move money"
 * preselects when opened from a category's own row (design.md, "Assign / Move money": it
 * "preselects the category and the amount it is missing", `docs/ux/mockups/budget-month.html`'s
 * own `openMove`'s `gap`): the whole of a cash/card overspend first, else a reservation shortfall,
 * else (payment categories only) card debt still uncovered. Zero when none of these apply.
 */
export function amountNeededToCover(category: CategoryMonth): Cents {
  if (category.cashOverspending > 0 || category.creditOverspending > 0) {
    return category.cashOverspending + category.creditOverspending;
  }
  const short = reservationShortfall(category);
  if (short > 0) {
    return short;
  }
  return category.uncovered > 0 ? category.uncovered : 0;
}

/**
 * Builds the list in the mockup's own priority order: being assigned more than there is money
 * for comes first (if at all), then overspending (cash before card, since cash needs new money
 * immediately), overdue scheduled transactions, a reservation a category cannot cover (only when
 * that category is not already flagged by overspending above), uncovered card debt, and finally
 * every target still missing money as one combined item.
 */
export function computeTodos(input: TodosInput): readonly TodoItem[] {
  const items: TodoItem[] = [];

  for (const category of input.categories) {
    if (category.cashOverspending > 0) {
      // Covering the category in full needs its whole overspend, cash and card together — the
      // card portion gets its own item below only when there is no cash overspending alongside it.
      items.push({ kind: "cashOverspending", categoryId: category.categoryId, amountCents: category.cashOverspending + category.creditOverspending });
    } else if (category.creditOverspending > 0) {
      items.push({ kind: "cardOverspending", categoryId: category.categoryId, amountCents: category.creditOverspending });
    }
  }

  for (const item of input.overdueScheduledItems) {
    items.push({
      kind: "scheduledOverdue",
      scheduledTransactionId: item.scheduledTransactionId,
      categoryId: item.categoryId,
      payee: item.payee,
      date: item.date,
      amountCents: item.amountCents,
    });
  }

  for (const category of input.categories) {
    if (category.cashOverspending > 0 || category.creditOverspending > 0) continue;
    const short = reservationShortfall(category);
    if (short > 0) {
      items.push({ kind: "reservationShortfall", categoryId: category.categoryId, amountCents: short });
    }
  }

  for (const category of input.paymentCategories) {
    if (category.uncovered > 0) {
      items.push({ kind: "cardDebtUncovered", categoryId: category.categoryId, amountCents: category.uncovered });
    }
  }

  if (input.targetsNeeded.length > 0) {
    const total = input.targetsNeeded.reduce((sum, t) => sum + t.missingCents, 0);
    items.push({ kind: "targetsNeeded", categoryIds: input.targetsNeeded.map((t) => t.categoryId), amountCents: total });
  }

  if (input.unassignedCents < 0) {
    items.unshift({ kind: "overassigned", amountCents: -input.unassignedCents });
  }

  return items;
}
