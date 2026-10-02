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

  // Reset on every workspace/month change, unlike `useBudgetMonth`'s own deliberate choice not
  // to: a stale month's events drawn against the *new* month's day axis and "today" line would be
  // wrong, not just a jarring reload — the timeline has nothing honest to show until the right
  // month's own events arrive. Done during render (React's own "adjusting state when a prop
  // changes" pattern), not an effect, so it takes effect before the stale data ever paints.
  const key = `${workspaceId}|${month}`;
  const [resetForKey, setResetForKey] = useState(key);
  if (key !== resetForKey) {
    setResetForKey(key);
    setState({ status: "loading" });
  }

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
