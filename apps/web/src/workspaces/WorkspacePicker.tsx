import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";

import type { Workspace } from "./api.ts";
import "./WorkspacePicker.css";

/** More than one workspace to choose from (#50); a single one skips this screen entirely. */
export default function WorkspacePicker({ workspaces }: { workspaces: readonly Workspace[] }) {
  const intl = useIntl();
  const navigate = useNavigate();

  return (
    <main className="workspace-card" aria-live="polite">
      <p className="mark" aria-hidden="true">
        envelope
      </p>
      <p className="tag">
        {intl.formatMessage({ id: "workspacePicker.tagline", defaultMessage: "Choose a workspace to work in." })}
      </p>
      <ul className="workspace-list">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <button type="button" onClick={() => navigate(`/${workspace.id}`)}>
              {workspace.name}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
