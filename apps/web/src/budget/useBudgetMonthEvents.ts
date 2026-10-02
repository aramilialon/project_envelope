import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { getBudgetMonthEvents, type MonthEvent } from "./api.ts";

export type BudgetMonthEventsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; events: readonly MonthEvent[] };

/** Fetches a budget month's own events (#325, #326) — what `computeTimeline`/`computeTodos` are built from. */
export function useBudgetMonthEvents(workspaceId: string, month: string): BudgetMonthEventsState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<BudgetMonthEventsState>({ status: "loading" });

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    getBudgetMonthEvents(accessToken, workspaceId, month)
      .then((events) => {
        if (!cancelled) {
          setState({ status: "ok", events });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId, month]);

  return state;
}
