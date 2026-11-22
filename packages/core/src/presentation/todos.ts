import type { CategoryMonth } from "../budget/budget-month.ts";
import type { Cents } from "../money.ts";
import { cardDebt } from "./cardDebt.ts";

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
  | {
      readonly kind: "cashOverspending";
      readonly categoryId: string;
      readonly amountCents: Cents;
      /**
       * The part of `amountCents` that is the category's reservation shortfall (#728), present
       * only when it is above zero: an ordinary category with no credit overspending asks for its
       * cash overspending and its reservation shortfall in one item, so the interface can say so.
       */
      readonly reservationShortfallCents?: Cents;
    }
  | {
      readonly kind: "scheduledOverdue";
      readonly scheduledTransactionId: string;
      /** Null for scheduled income (#347) — it reserves no category. */
      readonly categoryId: string | null;
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
  /** Null for scheduled income (#347) — it reserves no category. */
  readonly categoryId: string | null;
  readonly payee: string;
  /** Its own due date (`YYYY-MM-DD`). */
  readonly date: string;
  /** Always positive: the expense's or income's own amount, not yet recorded. */
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
export function reservationShortfall(category: CategoryMonth): Cents {
  if (category.reserved <= 0) return 0;
  const beforeReservation = category.available + category.reserved;
  return Math.max(0, Math.min(category.reserved, category.reserved - Math.max(0, beforeReservation)));
}

/**
 * How much money a category still needs to stop being a problem — the same figure "Move money"
 * preselects when opened from a category's own row (design.md, "Assign / Move money": it
 * "preselects the category and the amount it is missing", `docs/ux/mockups/budget-month.html`'s
 * own `openMove`'s `gap`), the amount of the category's own "To do" item and what quick
 * assign's "Cover overspending" assigns to it. Zero when nothing applies.
 *
 * Card debt is asked once, on the card's payment category (#728). A category's credit
 * overspending is already part of its card's uncovered debt (the card owes it, and no money was
 * moved into the payment category for it), so it is never asked here as well: asking it on both
 * would set the same money aside twice. An ordinary category asks for its cash overspending,
 * plus its reservation shortfall when it has no credit overspending — with credit overspending,
 * money assigned to the category covers the card spending first and moves to the card (rule 4),
 * so it would not reach the reservation and would only lower what the card asks.
 *
 * A payment category asks `cardDebt`'s `toCover`: its cash overspending (the card was paid beyond
 * what was set aside, beyond the card's credit) plus its uncovered debt, `max(0, owed - available)`
 * with `owed` signed (#699, #660).
 * `uncovered` is always 0 on an ordinary category, and `reserved` always 0 on a payment category.
 */
export function amountNeededToCover(category: CategoryMonth): Cents {
  if (category.creditOverspending > 0) {
    return category.cashOverspending;
  }
  return category.cashOverspending + reservationShortfall(category) + category.uncovered;
}

/**
 * Builds the list in the mockup's own priority order: being assigned more than there is money
 * for comes first (if at all), then cash overspending, overdue scheduled transactions, a
 * reservation a category cannot cover (only when that category is not overspent), uncovered card
 * debt, and finally every target still missing money as one combined item.
 *
 * Card debt is asked once, on the card's payment category (#728): a category's credit
 * overspending gets no item of its own, since it is already inside its card's uncovered debt, and
 * a category overspent in cash asks only for what `amountNeededToCover` gives it, never its card
 * part. A card paid beyond what its payment category set aside is cash overspending like any other,
 * listed with the rest of it, for the whole of `cardDebt`'s `toCover` — the overspending plus the
 * debt still uncovered, one item, never a second "debt to cover" one for the same card (#699).
 */
export function computeTodos(input: TodosInput): readonly TodoItem[] {
  const items: TodoItem[] = [];

  for (const category of input.categories) {
    if (category.cashOverspending > 0) {
      const amountCents = amountNeededToCover(category);
      const short = amountCents - category.cashOverspending;
      items.push({
        kind: "cashOverspending",
        categoryId: category.categoryId,
        amountCents,
        ...(short > 0 ? { reservationShortfallCents: short } : {}),
      });
    }
  }
  for (const category of input.paymentCategories) {
    if (category.cashOverspending > 0) {
      items.push({ kind: "cashOverspending", categoryId: category.categoryId, amountCents: cardDebt(category).toCover });
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
    if (category.cashOverspending > 0) continue;
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
