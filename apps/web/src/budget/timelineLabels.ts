import type { useIntl } from "react-intl";

/**
 * "Supermarket, Restaurant and 5 more" (design.md: a day with several events never spells out
 * every one) — `Intl.ListFormat` composes the payee list itself, a translated message the "and N
 * more" tail, so neither reads as a stray "+5" that could be mistaken for a signed amount (the
 * timeline's own "+" already means an inflow). Shared by `BudgetScreen.tsx` (feeding
 * `computeTimeline`'s own `formatPayees`, so its label-width estimate matches exactly what gets
 * rendered) and `Timeline.tsx` (the actual render) — one implementation, not two that could drift
 * apart.
 */
export function formatPayees(payees: readonly string[], extraPayeeCount: number, intl: ReturnType<typeof useIntl>): string {
  const list = new Intl.ListFormat(intl.locale, { style: "long", type: "conjunction" }).format(payees);
  if (extraPayeeCount === 0) {
    return list;
  }
  return intl.formatMessage({ id: "budget.timeline.morePayees", defaultMessage: "{payees} and {count} more" }, { payees: list, count: extraPayeeCount });
}
