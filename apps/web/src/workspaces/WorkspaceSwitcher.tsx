import { useState } from "react";
import { useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";

import { useWorkspaces } from "./useWorkspaces.ts";
import "./WorkspaceSwitcher.css";

/**
 * The sidebar's workspace switcher (#50, `docs/ux/mockups/settings-first-run.html`): a button
 * naming the current workspace, opening a popover listing every workspace the user belongs to.
 * "Workspace settings" and "+ New workspace", also drawn in that mockup, are left out — neither
 * feature exists yet, and a button that does nothing is worse than no button.
 */
export default function WorkspaceSwitcher() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const state = useWorkspaces();
  const [open, setOpen] = useState(false);
  const intl = useIntl();
  const navigate = useNavigate();

  // Loading or failed: the switcher simply does not render yet; the rest of the screen still
  // works, since the workspace is already known from the URL.
  if (state.status !== "ok") {
    return null;
  }

  const current = state.workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="workspace-switcher">
      <button type="button" className="ws" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {current?.name ?? workspaceId}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <span>{intl.formatMessage({ id: "workspaceSwitcher.label", defaultMessage: "Workspace" })}</span>
          {state.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate(`/${workspace.id}`);
              }}
            >
              {workspace.name}
              {workspace.id === workspaceId ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
