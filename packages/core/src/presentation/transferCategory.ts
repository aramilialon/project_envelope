import type { Cents } from "../money.ts";

/** One end of a transfer, as far as the category rule cares: whether it is in the budget, and whether it is a credit card. */
export interface TransferEnd {
  readonly onBudget: boolean;
  readonly creditCard: boolean;
}

/**
 * What a transfer's category choice is (#598, #599; domain guide, "Money moved to an off-budget
 * account"):
 *
 * - `"none"`: both accounts are on budget, or both off budget. The money stays where it was as
 *   far as the budget goes, and neither leg takes a category.
 * - `"required"`: the money leaves the budget (an on-budget account to an off-budget one), or comes
 *   in from an off-budget account into an on-budget credit card, where income is not modeled yet.
 *   The on-budget leg needs a real category.
 * - `"optional"`: the money comes in from an off-budget account into an on-budget cash account.
 *   With no category it is income to assign ("Unassigned") in the month of its date, the default;
 *   a real category can be chosen instead.
 */
export type TransferCategoryRule = "none" | "required" | "optional";

export function transferCategoryRule(source: TransferEnd, destination: TransferEnd): TransferCategoryRule {
  if (source.onBudget === destination.onBudget) {
    return "none";
  }
  if (source.onBudget) {
    return "required";
  }
  return destination.creditCard ? "required" : "optional";
}

/** What money coming in does to the available amount it lands in ("Unassigned" or a category): from what it holds to that plus the amount. */
export interface AvailableChange {
  readonly fromCents: Cents;
  readonly toCents: Cents;
}

export function availableAfterInflow(availableCents: Cents, inflowCents: Cents): AvailableChange {
  return { fromCents: availableCents, toCents: availableCents + inflowCents };
}
