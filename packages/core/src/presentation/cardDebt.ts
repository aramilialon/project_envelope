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
  /** The card's real debt (`CategoryMonth.owed`), negative when the card is in credit; 0 when the card's balance is not known. */
  readonly owed: Cents;
  /** Money set aside to pay the card: `max(0, available)`, never negative. */
  readonly setAside: Cents;
  /**
   * How much the card was paid beyond what was set aside and beyond its own credit: the payment
   * category's cash overspending, `max(0, -available - credit)` with credit = `max(0, -owed)`
   * (#660). A negative available down to minus the card's credit is the card in credit, not
   * money paid beyond.
   */
  readonly paidBeyondSetAside: Cents;
  /** Part of the debt no money set aside covers yet (`CategoryMonth.uncovered`). */
  readonly uncovered: Cents;
  /**
   * What it takes to bring the payment category back to covering the whole debt:
   * `cashOverspending + uncovered`, that is `max(0, owed - available)` with `owed` signed (#660):
   * a card in credit may hold a payment category down to minus its credit with nothing to cover.
   * The status line, the detail's "To cover", the "To do" item, "Assign" and quick assign's
   * "cover card debt" all use this one figure.
   */
  readonly toCover: Cents;
}

export function cardDebt(category: Pick<CategoryMonth, "available" | "uncovered" | "owed" | "cashOverspending">): CardDebt {
  const owed = category.owed ?? 0;
  return {
    owed,
    setAside: Math.max(0, category.available),
    paidBeyondSetAside: category.cashOverspending,
    uncovered: category.uncovered,
    toCover: Math.max(0, owed - category.available),
  };
}
