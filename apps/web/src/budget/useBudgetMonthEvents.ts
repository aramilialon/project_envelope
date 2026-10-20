import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { getBudgetMonthEvents, type MonthEvent } from "./api.ts";

export type BudgetMonthEventsState = FetchState<{ events: readonly MonthEvent[] }>;

/** Fetches a budget month's own events (#325, #326) — what `computeTimeline`/`computeTodos` are built from. */
export function useBudgetMonthEvents(workspaceId: string, month: string): BudgetMonthEventsState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;

  // Resets on every workspace/month change, unlike `useBudgetMonth`'s own deliberate choice not
  // to: a stale month's events drawn against the *new* month's day axis and "today" line would be
  // wrong, not just a jarring reload — the timeline has nothing honest to show until the right
  // month's own events arrive.
  const state = useFetchState(
    () => (accessToken ? getBudgetMonthEvents(accessToken, workspaceId, month).then((events) => ({ events })) : undefined),
    [accessToken, workspaceId, month],
    { resetOnDepsChange: true },
  );
  // No `refetch` here, unlike most of this hook's siblings: nothing calls it (events follow the
  // month/workspace alone), so the type stays exactly what it was before `useFetchState` existed.
  return state.status === "ok" ? { status: "ok", events: state.events } : { status: state.status };
}
