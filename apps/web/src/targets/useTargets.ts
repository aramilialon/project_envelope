import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { getGoal, type GoalProgress } from "./api.ts";

export type TargetsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; progressByCategory: ReadonlyMap<string, GoalProgress> };

/**
 * Fetches every target of the given categories for one month (#55). `apps/api` has no endpoint
 * to list every target of a workspace at once (`GET .../categories/:categoryId/goal` is
 * per-category), so this fetches them all in parallel — fine for the handful of categories a
 * personal workspace has, worth revisiting if it ever becomes a real cost.
 */
export function useTargets(workspaceId: string, month: string, categoryIds: readonly string[]): TargetsState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<TargetsState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const categoryIdsKey = categoryIds.join(",");

  useEffect(() => {
    if (!accessToken || categoryIdsKey === "") {
      return;
    }
    let cancelled = false;
    const ids = categoryIdsKey.split(",");
    Promise.all(ids.map((id) => getGoal(accessToken, workspaceId, id, month)))
      .then((results) => {
        if (cancelled) {
          return;
        }
        const progressByCategory = new Map<string, GoalProgress>();
        results.forEach((progress, index) => {
          if (progress) {
            progressByCategory.set(ids[index]!, progress);
          }
        });
        setState({ status: "ok", progressByCategory });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId, month, categoryIdsKey, generation]);

  const refetch = () => setGeneration((g) => g + 1);

  if (categoryIdsKey === "") {
    return { status: "ok", progressByCategory: new Map(), refetch };
  }
  return { ...state, refetch };
}
