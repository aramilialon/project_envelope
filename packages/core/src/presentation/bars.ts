import type { CategoryMonth } from "../budget/budget-month.ts";

/**
 * A category's bar geometry (design.md, "Budget month on the desktop" — "Bars";
 * `docs/ux/mockups/budget-month.html`'s own `barHtml`, the literal reference this mirrors).
 * Plain percentages and an enum out, never HTML or translated text (no user-facing text in
 * `packages/core`) — `apps/web`'s `Bar.tsx` turns this into the `.bar`/`.tr`/`.sp`/`.rs`/`.tail`
 * markup the mockup's own CSS styles.
 *
 * The bar has two zones: the **track** (`TRACK_PERCENT`, 82% of the bar's own width) is what the
 * category has ever had — carried over plus assigned, never negative; past it, the **tail**
 * (at most `TAIL_PERCENT`, 18%) is how far spending and reservations spill beyond the track.
 * `spentPercent`/`reserved` are percentages of the *track's own width* (they nest inside it);
 * `tail`'s percentage is of the *bar's full width* (it starts right where the track ends).
 */

export const TRACK_PERCENT = 82;
export const TAIL_PERCENT = 18;

/** Why a bar's tail is drawn: real overspending (paid with cash or a credit card), or a reservation the category cannot cover (a warning, never overspending). */
export type TailKind = "cash" | "credit" | "short";

export interface BarSegment {
  readonly leftPercent: number;
  readonly widthPercent: number;
}

export interface CategoryBar {
  readonly kind: "category";
  /** Whether there is a track at all (carried over + assigned > 0) — never carried/assigned draws a plain, empty track instead of one that is simply all still available. */
  readonly hasBudget: boolean;
  /** % of the track's own width (0-100) that is already spent. */
  readonly spentPercent: number;
  /** % of the track's own width reserved by not-yet-recorded scheduled transactions; absent when there is none. */
  readonly reserved: BarSegment | undefined;
  /** % of the *bar's full width* spilling past the track; absent when nothing does. */
  readonly tail: { readonly kind: TailKind; readonly widthPercent: number } | undefined;
}

export interface PaymentCategoryBar {
  readonly kind: "payment";
  /** % of the *bar's full width*, which here represents the card's own real debt; absent when fully covered (or there is no debt at all). */
  readonly uncovered: BarSegment | undefined;
}

export type Bar = CategoryBar | PaymentCategoryBar;

function pct(value: number, of: number): number {
  return of > 0 ? Math.max(0, Math.min(100, (value / of) * 100)) : 0;
}

/** An ordinary category's bar (never a card's own payment category — see `computePaymentCategoryBar`). */
export function computeCategoryBar(category: CategoryMonth): CategoryBar {
  const budget = Math.max(0, category.carriedOver + category.assigned);
  const spent = Math.max(0, -category.activity);
  const reservedAmount = category.reserved;

  let spentPercent: number;
  let reservedPercent: number;
  let overPercent: number;
  if (budget > 0) {
    spentPercent = pct(Math.min(spent, budget), budget);
    reservedPercent = pct(Math.min(reservedAmount, Math.max(0, budget - spent)), budget);
    // Scaled by TRACK_PERCENT, not 100: the tail continues the track's own per-cent scale, so a
    // category 10% over its budget gets a tail 10% as long as the track, not 10% of the whole bar.
    overPercent = (Math.max(0, spent + reservedAmount - budget) / budget) * TRACK_PERCENT;
  } else {
    // No track to measure against: anything at all overflows to the tail's own maximum at once.
    spentPercent = 0;
    reservedPercent = 0;
    overPercent = spent + reservedAmount > 0 ? TAIL_PERCENT : 0;
  }

  const tailWidth = Math.min(TAIL_PERCENT, overPercent);
  // Precedence matches the mockup's own: a category can be overspent on both a cash account and
  // a credit card in the same month (CategoryMonth's own doc: "part"/"rest" of one deficit); credit
  // wins the tail's colour, same as `budget-month.html`'s own `barHtml`.
  let tailKind: TailKind | undefined;
  if (category.creditOverspending > 0) {
    tailKind = "credit";
  } else if (category.cashOverspending > 0) {
    tailKind = "cash";
  } else if (tailWidth > 0) {
    tailKind = "short";
  }

  return {
    kind: "category",
    hasBudget: budget > 0,
    spentPercent,
    reserved: reservedPercent > 0 ? { leftPercent: spentPercent, widthPercent: reservedPercent } : undefined,
    tail: tailKind && tailWidth > 0 ? { kind: tailKind, widthPercent: tailWidth } : undefined,
  };
}

/**
 * A credit card's own payment category: the bar draws its debt instead of a track/tail (covered
 * in `bar`, uncovered hatched) — `CategoryMonth.uncovered` is already `max(0, owed - available)`,
 * so the card's real debt (never stored directly here) is recovered as `available + uncovered`
 * whenever there is any; when there is none, the bar needs no debt figure at all.
 */
export function computePaymentCategoryBar(category: CategoryMonth): PaymentCategoryBar {
  if (category.uncovered <= 0) {
    return { kind: "payment", uncovered: undefined };
  }
  const debt = category.available + category.uncovered;
  const coveredPercent = pct(Math.max(0, category.available), debt);
  return { kind: "payment", uncovered: { leftPercent: coveredPercent, widthPercent: 100 - coveredPercent } };
}
