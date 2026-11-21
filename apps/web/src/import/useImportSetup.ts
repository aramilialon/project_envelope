import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { listCategories, type Category } from "../categories/api.ts";
import { useFetchState, type FetchState } from "../useFetchState.ts";
import { getImportMapping, type CsvMapping } from "./api.ts";

export type ImportSetupState = FetchState<{
  account: Account;
  accounts: readonly Account[];
  categories: readonly Category[];
  savedMapping: CsvMapping | undefined;
}>;

/**
 * Fetches what the import screen (#59) needs before a file is even picked: this account's own name, every other account (transfer destinations), every category (the review step's own picker), and a previously saved CSV mapping for this account, if any.
 * Through `useFetchState`, so a load refused over the API's rate limit is retried (#683).
 */
export function useImportSetup(workspaceId: string, accountId: string): ImportSetupState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;

  return useFetchState(
    () =>
      accessToken
        ? Promise.all([listAccounts(accessToken, workspaceId), listCategories(accessToken, workspaceId), getImportMapping(accessToken, workspaceId, accountId)]).then(
            ([accounts, categories, savedMapping]) => {
              const account = accounts.find((a) => a.id === accountId);
              if (!account) {
                throw new Error(`account ${accountId} not found`);
              }
              return { account, accounts, categories, savedMapping };
            },
          )
        : undefined,
    [accessToken, workspaceId, accountId],
  );
}
