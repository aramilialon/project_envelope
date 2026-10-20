import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { listCategories, listCategoryGroups, type Category, type CategoryGroup } from "./api.ts";

export type CategoriesState = FetchState<{ groups: readonly CategoryGroup[]; categories: readonly Category[] }>;

/** Fetches a workspace's category groups and categories together (#52), with a `refetch`. */
export function useCategories(workspaceId: string): CategoriesState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  return useFetchState(
    () =>
      accessToken
        ? Promise.all([listCategoryGroups(accessToken, workspaceId), listCategories(accessToken, workspaceId)]).then(
            ([groups, categories]) => ({ groups, categories }),
          )
        : undefined,
    [accessToken, workspaceId],
  );
}
