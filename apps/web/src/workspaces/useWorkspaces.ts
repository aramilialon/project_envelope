import { useCallback, useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listMyWorkspaces, type Workspace } from "./api.ts";

export type WorkspacesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; workspaces: readonly Workspace[] };

/**
 * Fetches the signed-in user's own workspaces (#50), re-fetching whenever the access token
 * changes, or on demand via `refetch` — needed after creating one (`#394`), so the switcher's own
 * list includes it without waiting for the next token refresh.
 */
export function useWorkspaces(): WorkspacesState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<WorkspacesState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    // Deliberately does not reset to "loading" here: a silent token refresh re-runs this
    // effect, and flashing the whole screen back to a spinner on every refresh would be worse
    // than briefly showing the previous list while the new one loads in the background.
    listMyWorkspaces(accessToken)
      .then((workspaces) => {
        if (!cancelled) {
          setState({ status: "ok", workspaces });
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
  }, [accessToken, generation]);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, refetch };
}
