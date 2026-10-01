import { useCallback, useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listCategories, listCategoryGroups, type Category, type CategoryGroup } from "./api.ts";

export type CategoriesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; groups: readonly CategoryGroup[]; categories: readonly Category[] };

/** Fetches a workspace's category groups and categories together (#52), with a `refetch`. */
export function useCategories(workspaceId: string): CategoriesState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<CategoriesState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    Promise.all([listCategoryGroups(accessToken, workspaceId), listCategories(accessToken, workspaceId)])
      .then(([groups, categories]) => {
        if (!cancelled) {
          setState({ status: "ok", groups, categories });
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
  }, [accessToken, workspaceId, generation]);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, refetch };
}
