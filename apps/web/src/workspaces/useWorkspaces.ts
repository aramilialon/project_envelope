import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listMyWorkspaces, type Workspace } from "./api.ts";

export type WorkspacesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; workspaces: readonly Workspace[] };

/** Fetches the signed-in user's own workspaces (#50), re-fetching whenever the access token changes. */
export function useWorkspaces(): WorkspacesState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<WorkspacesState>({ status: "loading" });

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
  }, [accessToken]);

  return state;
}
