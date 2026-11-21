import type { CategoryMonth } from "../budget/budget-month.ts";
import type { Cents } from "../money.ts";

/**
 * A credit card's own payment category, as the interface shows it (design.md, "Card payment
 * category"; #699): the card's real debt, what is set aside for it, what was paid beyond what was
 * set aside, and what it takes to cover all of it. Every figure the status line, the bar, the
 * detail panel, the "To do" list and "Assign" read for a payment category comes from here, so
 * none of them derives a debt figure of its own.
 */
export interface CardDebt {
  /** The card's real debt (`CategoryMonth.owed`); 0 when the card's balance is not known. */
  readonly owed: Cents;
  /** Money set aside to pay the card: `max(0, available)`, never negative. */
  readonly setAside: Cents;
  /** How much the card was paid beyond what was set aside: `max(0, -available)` (the category's cash overspending). */
  readonly paidBeyondSetAside: Cents;
  /** Part of the debt no money set aside covers yet (`CategoryMonth.uncovered`). */
  readonly uncovered: Cents;
  /**
   * What it takes to bring the payment category back to covering the whole debt:
   * `max(0, owed - available)` — the cash overspending plus the uncovered debt. A card whose
   * balance is in credit (negative `owed`) counts as owing nothing here, so the figure is never
   * less than the cash overspending itself.
   */
  readonly toCover: Cents;
}

export function cardDebt(category: Pick<CategoryMonth, "available" | "uncovered" | "owed">): CardDebt {
  const owed = category.owed ?? 0;
  return {
    owed,
    setAside: Math.max(0, category.available),
    paidBeyondSetAside: Math.max(0, -category.available),
    uncovered: category.uncovered,
    toCover: Math.max(0, Math.max(0, owed) - category.available),
  };
}
