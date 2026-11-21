import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { listGoalProgress, type GoalProgress } from "./api.ts";

export type TargetsState = FetchState<{ progressByCategory: ReadonlyMap<string, GoalProgress> }> & { refetch(): void };

/**
 * Fetches every target of the workspace for one month (#55), keyed by category, in a single
 * request (`GET .../goals?month=`, #682): a category without a target has no entry. The budget
 * screen calls this once for the month it shows and hands the result down to the panels that
 * need the same month's targets, so a month view costs one targets request.
 */
export function useTargets(workspaceId: string, month: string): TargetsState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  return useFetchState(
    () =>
      accessToken
        ? listGoalProgress(accessToken, workspaceId, month).then((goals) => ({
            progressByCategory: new Map(goals.map((progress) => [progress.goal.categoryId, progress] as const)),
          }))
        : undefined,
    [accessToken, workspaceId, month],
  );
}
