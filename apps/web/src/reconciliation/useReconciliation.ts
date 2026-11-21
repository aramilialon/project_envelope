import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { listCategories, type Category } from "../categories/api.ts";
import { useFetchState, type FetchState } from "../useFetchState.ts";
import { getReconciliationCandidates, type ReconciliationCandidates } from "./api.ts";

export type ReconciliationState = FetchState<{
  account: Account;
  categories: readonly Category[];
  candidates: ReconciliationCandidates;
}>;

/**
 * Fetches everything the reconciliation screen (#60) needs for a given statement date: this
 * account's own name (to find it has no endpoint of its own, `listAccounts` is already fetched
 * elsewhere for the same reason), every category (the adjustment picker) and the candidates
 * eligible as of that date (`GET .../reconciliation-candidates?date=`). Re-fetches whenever
 * `date` changes, since eligibility is defined relative to it. Through `useFetchState`, so a load
 * refused over the API's rate limit is retried (#683).
 */
export function useReconciliation(
  workspaceId: string,
  accountId: string,
  date: string,
): ReconciliationState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;

  return useFetchState(
    () =>
      accessToken
        ? Promise.all([
            listAccounts(accessToken, workspaceId),
            listCategories(accessToken, workspaceId),
            getReconciliationCandidates(accessToken, workspaceId, accountId, date),
          ]).then(([accounts, categories, candidates]) => {
            const account = accounts.find((a) => a.id === accountId);
            if (!account) {
              throw new Error(`account ${accountId} not found`);
            }
            return { account, categories, candidates };
          })
        : undefined,
    [accessToken, workspaceId, accountId, date],
  );
}
