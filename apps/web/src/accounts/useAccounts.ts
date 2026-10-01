import { useCallback, useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "./api.ts";

export type AccountsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; accounts: readonly Account[] };

/** Fetches a workspace's accounts (#51), with a `refetch` for after a create or a close. */
export function useAccounts(workspaceId: string): AccountsState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<AccountsState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    listAccounts(accessToken, workspaceId)
      .then((accounts) => {
        if (!cancelled) {
          setState({ status: "ok", accounts });
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
