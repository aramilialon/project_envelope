import { useCallback, useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { listCategories, type Category } from "../categories/api.ts";
import { getReconciliationCandidates, type ReconciliationCandidates } from "./api.ts";

export type ReconciliationState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ok";
      account: Account;
      categories: readonly Category[];
      candidates: ReconciliationCandidates;
    };

/**
 * Fetches everything the reconciliation screen (#60) needs for a given statement date: this
 * account's own name (to find it has no endpoint of its own, `listAccounts` is already fetched
 * elsewhere for the same reason), every category (the adjustment picker) and the candidates
 * eligible as of that date (`GET .../reconciliation-candidates?date=`). Re-fetches whenever
 * `date` changes, since eligibility is defined relative to it.
 */
export function useReconciliation(
  workspaceId: string,
  accountId: string,
  date: string,
): ReconciliationState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<ReconciliationState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    Promise.all([listAccounts(accessToken, workspaceId), listCategories(accessToken, workspaceId), getReconciliationCandidates(accessToken, workspaceId, accountId, date)])
      .then(([accounts, categories, candidates]) => {
        if (cancelled) {
          return;
        }
        const account = accounts.find((a) => a.id === accountId);
        if (!account) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ok", account, categories, candidates });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId, accountId, date, generation]);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, refetch };
}
