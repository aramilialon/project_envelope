import { useIntl } from "react-intl";
import { Navigate } from "react-router-dom";

import WorkspacePicker from "./WorkspacePicker.tsx";
import { useWorkspaces } from "./useWorkspaces.ts";
import "./WorkspacePicker.css";

/**
 * The "/" route (#50): fetches the signed-in user's own workspaces and decides what to show —
 * none (nothing to enter yet), exactly one (skip straight to it, no pointless extra screen for
 * the common personal/family case), or several (`WorkspacePicker`).
 */
export default function WorkspaceGate() {
  const intl = useIntl();
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

  if (state.workspaces.length === 1) {
    return <Navigate to={`/${state.workspaces[0]!.id}`} replace />;
  }

  return <WorkspacePicker workspaces={state.workspaces} />;
}
