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
      /**
       * The part of `amountCents` that is the category's card spending (its credit overspending,
       * #731), present only when the category also has a reservation shortfall: covering the card
       * spending first is what lets money reach the reservation (rule 4). Its card asks that much
       * less (`askedOnCategories`).
       */
      readonly cardSpendingCents?: Cents;
      /**
       * Payment categories only (#731): the part of the card's to cover that is asked on ordinary
       * categories instead — each one's card spending on this card, when it is asked there together
       * with a reservation shortfall. `amountCents` is already net of it; present only when not empty.
       */
      readonly askedOnCategories?: readonly CardPartAsked[];
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
  | {
      readonly kind: "reservationShortfall";
      readonly categoryId: string;
      readonly amountCents: Cents;
      /** As on `cashOverspending` (#731): the card spending asked with the reservation, when the category has any. */
      readonly cardSpendingCents?: Cents;
    }
  | {
      readonly kind: "cardDebtUncovered";
      readonly categoryId: string;
      readonly amountCents: Cents;
      /** As on a payment category's `cashOverspending` item (#731). */
      readonly askedOnCategories?: readonly CardPartAsked[];
    }
  | { readonly kind: "targetsNeeded"; readonly categoryIds: readonly string[]; readonly amountCents: Cents };

/** Part of a card's debt asked on an ordinary category instead of on the card (#731). */
export interface CardPartAsked {
  readonly categoryId: string;
  readonly amountCents: Cents;
}

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
 * Card debt is asked once (#728). A category's credit overspending is already part of its card's
 * uncovered debt (the card owes it, and no money was moved into the payment category for it), so
 * it is asked on the card, never on both: that would set the same money aside twice. An ordinary
 * category asks for its cash overspending plus its reservation shortfall. With credit overspending
 * C and a reservation shortfall R, it asks cash + C + R (#731): money assigned to it covers the
 * card spending first and moves to the card (rule 4), so C must be covered for anything to reach
 * the reservation; that C is then not asked on the card (`cardPartsAskedOnCategories`). With
 * credit overspending and no shortfall, it asks only its cash overspending.
 *
 * A payment category asks `cardDebt`'s `toCover`: its cash overspending (the card was paid beyond
 * what was set aside, beyond the card's credit) plus its uncovered debt, `max(0, owed - available)`
 * with `owed` signed (#699, #660).
 * `uncovered` is always 0 on an ordinary category, and `reserved` always 0 on a payment category.
 */
export function amountNeededToCover(category: CategoryMonth): Cents {
  if (category.creditOverspending > 0) {
    const short = reservationShortfall(category);
    return short > 0 ? category.cashOverspending + category.creditOverspending + short : category.cashOverspending;
  }
  return category.cashOverspending + reservationShortfall(category) + category.uncovered;
}

/**
 * For each card, the parts of its debt asked on ordinary categories instead (#731): the credit
 * overspending each category with a reservation shortfall has on that card (`overspendingBy`),
 * since `amountNeededToCover` asks it there. Cards with nothing asked elsewhere have no entry.
 */
export function cardPartsAskedOnCategories(
  categories: readonly CategoryMonth[],
  paymentCategories: readonly CategoryMonth[],
): ReadonlyMap<string, readonly CardPartAsked[]> {
  const asking = new Set(categories.filter((c) => c.creditOverspending > 0 && reservationShortfall(c) > 0).map((c) => c.categoryId));
  const byCard = new Map<string, readonly CardPartAsked[]>();
  if (asking.size === 0) return byCard;
  for (const card of paymentCategories) {
    const parts = (card.overspendingBy ?? [])
      .filter((p) => asking.has(p.categoryId) && p.amount > 0)
      .map((p) => ({ categoryId: p.categoryId, amountCents: p.amount }));
    if (parts.length > 0) byCard.set(card.categoryId, parts);
  }
  return byCard;
}

/**
 * What a card's own "To do" item asks (#731): its `cardDebt` to cover (its uncovered debt when it
 * was not paid beyond what was set aside, the same figure), less what is asked on ordinary
 * categories for it (`cardPartsAskedOnCategories`), never below zero.
 */
export function cardAmountAsked(card: CategoryMonth, askedOnCategories: readonly CardPartAsked[]): Cents {
  const elsewhere = askedOnCategories.reduce((sum, p) => sum + p.amountCents, 0);
  const toCover = card.cashOverspending > 0 ? cardDebt(card).toCover : card.uncovered;
  return Math.max(0, toCover - elsewhere);
}

/**
 * Builds the list in the mockup's own priority order: being assigned more than there is money
 * for comes first (if at all), then cash overspending, overdue scheduled transactions, a
 * reservation a category cannot cover (only when that category is not overspent), uncovered card
 * debt, and finally every target still missing money as one combined item.
 *
 * Card debt is asked once (#728): a category's credit overspending gets no item of its own, since
 * it is already inside its card's uncovered debt, and a category asks only for what
 * `amountNeededToCover` gives it. The one exception (#731): a category with a reservation
 * shortfall asks its card spending too, in its own item (`cardSpendingCents`), and each card it
 * spent on asks that much less (`askedOnCategories`; an item that would ask nothing is left out).
 * A card paid beyond what its payment category set aside is cash overspending like any other,
 * listed with the rest of it, for the whole of `cardDebt`'s `toCover` — the overspending plus the
 * debt still uncovered, one item, never a second "debt to cover" one for the same card (#699).
 */
export function computeTodos(input: TodosInput): readonly TodoItem[] {
  const items: TodoItem[] = [];
  const askedElsewhere = cardPartsAskedOnCategories(input.categories, input.paymentCategories);
  // #731: the card spending a category asks together with its reservation shortfall.
  const cardSpendingAsked = (category: CategoryMonth): Cents =>
    category.creditOverspending > 0 && reservationShortfall(category) > 0 ? category.creditOverspending : 0;

  for (const category of input.categories) {
    if (category.cashOverspending > 0) {
      const amountCents = amountNeededToCover(category);
      const cardSpending = cardSpendingAsked(category);
      const short = amountCents - category.cashOverspending - cardSpending;
      items.push({
        kind: "cashOverspending",
        categoryId: category.categoryId,
        amountCents,
        ...(short > 0 ? { reservationShortfallCents: short } : {}),
        ...(cardSpending > 0 ? { cardSpendingCents: cardSpending } : {}),
      });
    }
  }
  for (const category of input.paymentCategories) {
    if (category.cashOverspending > 0) {
      const asked = askedElsewhere.get(category.categoryId) ?? [];
      const amountCents = cardAmountAsked(category, asked);
      if (amountCents > 0) {
        items.push({
          kind: "cashOverspending",
          categoryId: category.categoryId,
          amountCents,
          ...(asked.length > 0 ? { askedOnCategories: asked } : {}),
        });
      }
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
    if (category.cashOverspending > 0) continue;
    const short = reservationShortfall(category);
    if (short > 0) {
      const cardSpending = cardSpendingAsked(category);
      items.push({
        kind: "reservationShortfall",
        categoryId: category.categoryId,
        amountCents: cardSpending + short,
        ...(cardSpending > 0 ? { cardSpendingCents: cardSpending } : {}),
      });
    }
  }

  for (const category of input.paymentCategories) {
    if (category.cashOverspending > 0) continue;
    if (category.uncovered > 0) {
      const asked = askedElsewhere.get(category.categoryId) ?? [];
      const amountCents = cardAmountAsked(category, asked);
      if (amountCents > 0) {
        items.push({
          kind: "cardDebtUncovered",
          categoryId: category.categoryId,
          amountCents,
          ...(asked.length > 0 ? { askedOnCategories: asked } : {}),
        });
      }
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
