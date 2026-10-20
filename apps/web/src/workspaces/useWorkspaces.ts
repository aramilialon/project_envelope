import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { listMyWorkspaces, type Workspace } from "./api.ts";

export type WorkspacesState = FetchState<{ workspaces: readonly Workspace[] }>;

/**
 * Fetches the signed-in user's own workspaces (#50), re-fetching whenever the access token
 * changes, or on demand via `refetch` — needed after creating one (`#394`), so the switcher's own
 * list includes it without waiting for the next token refresh.
 *
 * Deliberately does not reset to "loading" (`useFetchState`'s default): a silent token refresh
 * re-runs this effect, and flashing the whole screen back to a spinner on every refresh would be
 * worse than briefly showing the previous list while the new one loads in the background.
 */
export function useWorkspaces(): WorkspacesState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  return useFetchState(
    () => (accessToken ? listMyWorkspaces(accessToken).then((workspaces) => ({ workspaces })) : undefined),
    [accessToken],
  );
}
