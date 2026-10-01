import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listCategoryGroups } from "../categories/api.ts";
import { getBudgetMonth, type BudgetMonthCategory, type BudgetMonthResponse } from "./api.ts";

export interface BudgetGroup {
  readonly id: string;
  readonly name: string;
  readonly categories: readonly BudgetMonthCategory[];
}

export type BudgetMonthState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; budgetMonth: BudgetMonthResponse; groups: readonly BudgetGroup[] };

/**
 * Fetches a workspace's budget month (#53) and groups its categories (ordinary and payment
 * categories together — a payment category belongs to a real, ordinary category group,
 * `apps/api`'s own "Credit card payments", so no special-casing is needed) in the workspace's
 * own group order. `getBudgetMonth` alone cannot order groups against each other — it joins
 * each category with its group's *name*, not its `sortOrder` — so this also fetches
 * `category-groups` (#52) for that.
 */
export function useBudgetMonth(workspaceId: string, month: string): BudgetMonthState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<BudgetMonthState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    // Deliberately does not reset to "loading" here, the same way `useAccounts`/`useCategories`
    // don't: switching months should swap straight to the new numbers, not blank the whole
    // table to a spinner first.
    Promise.all([getBudgetMonth(accessToken, workspaceId, month), listCategoryGroups(accessToken, workspaceId)])
      .then(([budgetMonth, categoryGroups]) => {
        if (cancelled) {
          return;
        }
        const allCategories = [...budgetMonth.categories, ...budgetMonth.paymentCategories];
        const byGroup = new Map<string, BudgetMonthCategory[]>();
        for (const category of allCategories) {
          const list = byGroup.get(category.groupId);
          if (list) {
            list.push(category);
          } else {
            byGroup.set(category.groupId, [category]);
          }
        }
        const groups: BudgetGroup[] = [...categoryGroups]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((g) => ({
            id: g.id,
            name: g.name,
            categories: (byGroup.get(g.id) ?? []).toSorted((a, b) => a.sortOrder - b.sortOrder),
          }))
          .filter((g) => g.categories.length > 0);
        setState({ status: "ok", budgetMonth, groups });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId, month, generation]);

  const refetch = () => setGeneration((g) => g + 1);

  return { ...state, refetch };
}
