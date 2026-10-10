import type { Cents } from "../money.ts";

/**
 * The three unresolved budget problems design.md's own "Notifications" names verbatim: "a
 * category goes negative, a purchase exceeds the available balance, or money arrives to be
 * assigned" (the first two are the same thing — a negative `available` — for an ordinary
 * category and a card's own payment category respectively; the second also carries its own
 * `uncovered_card_debt` reading once the debt is real, not just transiently negative for a day).
 */
export type BudgetProblemKind = "overspent_category" | "uncovered_card_debt" | "unassigned_money";

export interface BudgetProblem {
  readonly kind: BudgetProblemKind;
  /** Absent only for "unassigned_money", which is not about any one category. */
  readonly categoryId?: string;
  readonly name?: string;
  readonly groupName?: string;
  /** How negative the category is, how much of its card debt is uncovered, or how much unassigned money sits idle. */
  readonly amountCents: Cents;
}

/**
 * A structural subset of `apps/api`'s own `BudgetMonthCategory`/`apps/web`'s own
 * `BudgetMonthCategory` (and `packages/core`'s own `CategoryMonth`, once a caller has joined in
 * `name`/`groupName`) — whichever already-fetched shape a caller has on hand, never imported
 * from here, so `packages/core` stays dependency-free.
 */
export interface BudgetProblemCategory {
  readonly categoryId: string;
  readonly name?: string;
  readonly groupName?: string;
  readonly available: Cents;
  readonly uncovered: Cents;
}

export interface BudgetProblemInput {
  readonly unassigned: Cents;
  readonly categories: readonly BudgetProblemCategory[];
}

/**
 * The current issues a budget month has that need an owner or editor to act on (design.md,
 * "Notifications"; `#23`, `#40`) — derived entirely from an already-computed budget month, no
 * separate stored "problem" state. Shared by `apps/api` (the server-side push notification,
 * which only fires on a *new or changed* problem — that comparison is its own concern,
 * `notified-problems.ts`, not this function's) and `apps/web` (an instant, offline-capable alert
 * computed locally the moment an action changes the already-fetched budget month, design.md:
 * "the alert appears immediately, computed locally by the shared core, even offline").
 */
export function computeBudgetProblems(input: BudgetProblemInput): BudgetProblem[] {
  const problems: BudgetProblem[] = [];

  for (const category of input.categories) {
    if (category.available < 0) {
      problems.push({
        kind: "overspent_category",
        categoryId: category.categoryId,
        ...(category.name !== undefined ? { name: category.name } : {}),
        ...(category.groupName !== undefined ? { groupName: category.groupName } : {}),
        amountCents: -category.available,
      });
    }
    if (category.uncovered > 0) {
      problems.push({
        kind: "uncovered_card_debt",
        categoryId: category.categoryId,
        ...(category.name !== undefined ? { name: category.name } : {}),
        ...(category.groupName !== undefined ? { groupName: category.groupName } : {}),
        amountCents: category.uncovered,
      });
    }
  }

  if (input.unassigned > 0) {
    problems.push({ kind: "unassigned_money", amountCents: input.unassigned });
  }

  return problems;
}
