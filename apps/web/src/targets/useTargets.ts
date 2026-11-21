import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { getGoal, type GoalProgress } from "./api.ts";

export type TargetsState = FetchState<{ progressByCategory: ReadonlyMap<string, GoalProgress> }>;

/**
 * Fetches every target of the given categories for one month (#55). `apps/api` has no endpoint
 * to list every target of a workspace at once (`GET .../categories/:categoryId/goal` is
 * per-category), so this fetches them all in parallel — fine for the handful of categories a
 * personal workspace has, worth revisiting if it ever becomes a real cost. Through
 * `useFetchState`, so a load refused over the API's rate limit is retried (#683).
 */
export function useTargets(workspaceId: string, month: string, categoryIds: readonly string[]): TargetsState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const categoryIdsKey = categoryIds.join(",");

  const state = useFetchState(
    () => {
      if (!accessToken || categoryIdsKey === "") {
        return undefined;
      }
      const ids = categoryIdsKey.split(",");
      return Promise.all(ids.map((id) => getGoal(accessToken, workspaceId, id, month))).then((results) => {
        const progressByCategory = new Map<string, GoalProgress>();
        results.forEach((progress, index) => {
          if (progress) {
            progressByCategory.set(ids[index]!, progress);
          }
        });
        return { progressByCategory };
      });
    },
    [accessToken, workspaceId, month, categoryIdsKey],
  );

  if (categoryIdsKey === "") {
    return { status: "ok", progressByCategory: new Map(), refetch: state.refetch };
  }
  return state;
}
