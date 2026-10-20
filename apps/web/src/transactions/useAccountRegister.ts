import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { listCategories, type Category } from "../categories/api.ts";
import { getBudgetMonthEvents, type MonthEvent } from "../budget/api.ts";
import { useFetchState, type FetchState } from "../useFetchState.ts";
import { listTransactionsForAccount, type Transaction } from "./api.ts";

export type AccountRegisterState = FetchState<{
  account: Account;
  accounts: readonly Account[];
  categories: readonly Category[];
  transactions: readonly Transaction[];
  /** This account's own events for `month` (recorded, pending and not-yet-recorded scheduled items) — the timeline, the "Record" to-do items and the projected balance are all fed from this one fetch (`#337`). */
  events: readonly MonthEvent[];
}>;

/**
 * Fetches everything an account register (#54, #337) needs: this account's own transactions,
 * every workspace account (the transfer destination picker, and to find this one's own
 * name/type), every category (the picker, and to resolve a split's own name for display), and
 * this account's own events for `month` (`GET .../budget-months/:month/events?accountId=`, the
 * same endpoint the budget month's own timeline uses, `#325`/`#346`) — the account register has
 * no month navigation of its own, so the caller always passes the workspace's current one.
 */
export function useAccountRegister(workspaceId: string, accountId: string, month: string): AccountRegisterState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;

  return useFetchState(
    () => {
      if (!accessToken) {
        return undefined;
      }
      return Promise.all([
        listAccounts(accessToken, workspaceId),
        listCategories(accessToken, workspaceId),
        listTransactionsForAccount(accessToken, workspaceId, accountId),
        getBudgetMonthEvents(accessToken, workspaceId, month, accountId),
      ]).then(([accounts, categories, transactions, events]) => {
        const account = accounts.find((a) => a.id === accountId);
        if (!account) {
          throw new Error(`useAccountRegister: account ${accountId} not found in workspace ${workspaceId}`);
        }
        return { account, accounts, categories, transactions, events };
      });
    },
    [accessToken, workspaceId, accountId, month],
  );
}
