import { useCallback, useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { listCategories, type Category } from "../categories/api.ts";
import { listTransactionsForAccount, type Transaction } from "./api.ts";

export type AccountRegisterState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ok";
      account: Account;
      accounts: readonly Account[];
      categories: readonly Category[];
      transactions: readonly Transaction[];
    };

/**
 * Fetches everything an account register (#54) needs: this account's own transactions, every
 * workspace account (the transfer destination picker, and to find this one's own name/type),
 * and every category (the picker, and to resolve a split's own name for display).
 */
export function useAccountRegister(workspaceId: string, accountId: string): AccountRegisterState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<AccountRegisterState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    Promise.all([
      listAccounts(accessToken, workspaceId),
      listCategories(accessToken, workspaceId),
      listTransactionsForAccount(accessToken, workspaceId, accountId),
    ])
      .then(([accounts, categories, transactions]) => {
        if (cancelled) {
          return;
        }
        const account = accounts.find((a) => a.id === accountId);
        if (!account) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ok", account, accounts, categories, transactions });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId, accountId, generation]);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, refetch };
}
