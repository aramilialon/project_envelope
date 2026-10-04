import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { Navigate } from "react-router-dom";

import { clearLastUsedWorkspaceId, getLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import WorkspacePicker from "./WorkspacePicker.tsx";
import { useWorkspaces } from "./useWorkspaces.ts";
import "./WorkspacePicker.css";

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
      <main className="workspace-card" aria-live="polite">
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <p role="status">
          {intl.formatMessage({ id: "workspacePicker.loading", defaultMessage: "Loading your workspaces…" })}
        </p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="workspace-card" aria-live="polite">
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <div className="err" role="alert">
          <p>{intl.formatMessage({ id: "workspacePicker.error", defaultMessage: "We could not load your workspaces." })}</p>
        </div>
      </main>
    );
  }

  if (state.workspaces.length === 0) {
    return (
      <main className="workspace-card" aria-live="polite">
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <p>
          {intl.formatMessage({
            id: "workspacePicker.empty",
            defaultMessage: "You do not belong to any workspace yet.",
          })}
        </p>
      </main>
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
