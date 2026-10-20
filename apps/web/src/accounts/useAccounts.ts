import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { listAccounts, type Account } from "./api.ts";

export type AccountsState = FetchState<{ accounts: readonly Account[] }>;

/** Fetches a workspace's accounts (#51), with a `refetch` for after a create or a close. */
export function useAccounts(workspaceId: string): AccountsState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  return useFetchState(
    () => (accessToken ? listAccounts(accessToken, workspaceId).then((accounts) => ({ accounts })) : undefined),
    [accessToken, workspaceId],
  );
}
