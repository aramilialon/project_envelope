import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { listCategories, type Category } from "../categories/api.ts";
import { getImportMapping, type CsvMapping } from "./api.ts";

export type ImportSetupState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; account: Account; accounts: readonly Account[]; categories: readonly Category[]; savedMapping: CsvMapping | undefined };

/** Fetches what the import screen (#59) needs before a file is even picked: this account's own name, every other account (transfer destinations), every category (the review step's own picker), and a previously saved CSV mapping for this account, if any. */
export function useImportSetup(workspaceId: string, accountId: string): ImportSetupState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<ImportSetupState>({ status: "loading" });

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    Promise.all([listAccounts(accessToken, workspaceId), listCategories(accessToken, workspaceId), getImportMapping(accessToken, workspaceId, accountId)])
      .then(([accounts, categories, savedMapping]) => {
        if (cancelled) {
          return;
        }
        const account = accounts.find((a) => a.id === accountId);
        if (!account) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ok", account, accounts, categories, savedMapping });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId, accountId]);

  return state;
}
