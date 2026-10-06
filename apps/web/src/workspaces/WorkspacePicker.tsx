import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useNavigate } from "react-router-dom";

import CenteredCard from "../layout/CenteredCard.tsx";
import type { Workspace } from "./api.ts";
import { setLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import "./WorkspacePicker.css";

/**
 * More than one workspace to choose from (#50); a single one skips this screen entirely. Picking
 * one here is remembered the same way the band's own switcher remembers a later change (#343) —
 * otherwise this screen would show again on every sign-in, which is the one thing #343 exists to
 * stop happening for a multi-workspace user.
 */
export default function WorkspacePicker({ workspaces }: { workspaces: readonly Workspace[] }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const auth = useAuth();

  function choose(workspaceId: string) {
    const subject = auth.user?.profile?.sub;
    if (subject) {
      setLastUsedWorkspaceId(subject, workspaceId);
    }
    navigate(`/${workspaceId}`);
  }

  return (
    <CenteredCard>
      <p className="mark" aria-hidden="true">
        envelope
      </p>
      <p className="tag">
        {intl.formatMessage({ id: "workspacePicker.tagline", defaultMessage: "Choose a workspace to work in." })}
      </p>
      <ul className="workspace-list">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <button type="button" onClick={() => choose(workspace.id)}>
              {workspace.name}
            </button>
          </li>
        ))}
      </ul>
    </CenteredCard>
  );
}
