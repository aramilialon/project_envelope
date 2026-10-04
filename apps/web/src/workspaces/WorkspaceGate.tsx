import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { Navigate } from "react-router-dom";

import CenteredCard from "../layout/CenteredCard.tsx";
import { clearLastUsedWorkspaceId, getLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import WorkspacePicker from "./WorkspacePicker.tsx";
import { useWorkspaces } from "./useWorkspaces.ts";

/**
 * The "/" route (#50): fetches the signed-in user's own workspaces and decides what to show —
 * the last workspace this browser used, if the signed-in user is still a member of it (#343);
 * otherwise none (nothing to enter yet), exactly one (skip straight to it, no pointless extra
 * screen for the common personal/family case), or several (`WorkspacePicker`). A URL that already
 * names a workspace (`/:workspaceId`) never reaches this component at all — `App.tsx`'s own route
 * table sends it straight to `AppLayout` instead, which is rule 1 of #343's own order, satisfied
 * by routing alone.
 */
export default function WorkspaceGate() {
  const intl = useIntl();
  const auth = useAuth();
  const state = useWorkspaces();

  if (state.status === "loading") {
    return (
      <CenteredCard>
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <p role="status">
          {intl.formatMessage({ id: "workspacePicker.loading", defaultMessage: "Loading your workspaces…" })}
        </p>
      </CenteredCard>
    );
  }

  if (state.status === "error") {
    return (
      <CenteredCard>
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <div className="err" role="alert">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 2 1 21h22L12 2Zm0 6 7 12H5l7-12Zm-1 4h2v5h-2v-5Zm0 6h2v2h-2v-2Z" />
          </svg>
          <p>{intl.formatMessage({ id: "workspacePicker.error", defaultMessage: "We could not load your workspaces." })}</p>
        </div>
      </CenteredCard>
    );
  }

  if (state.workspaces.length === 0) {
    return (
      <CenteredCard>
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <p>
          {intl.formatMessage({
            id: "workspacePicker.empty",
            defaultMessage: "You do not belong to any workspace yet.",
          })}
        </p>
      </CenteredCard>
    );
  }

  const subject = auth.user?.profile?.sub;
  if (subject) {
    const lastUsedId = getLastUsedWorkspaceId(subject);
    if (lastUsedId !== null) {
      if (state.workspaces.some((w) => w.id === lastUsedId)) {
        return <Navigate to={`/${lastUsedId}`} replace />;
      }
      // Named a workspace the user can no longer reach (membership removed, workspace deleted).
      clearLastUsedWorkspaceId(subject);
    }
  }

  if (state.workspaces.length === 1) {
    return <Navigate to={`/${state.workspaces[0]!.id}`} replace />;
  }

  return <WorkspacePicker workspaces={state.workspaces} />;
}
