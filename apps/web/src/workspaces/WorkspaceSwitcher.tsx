import { useState } from "react";
import { useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";

import { useWorkspaces } from "./useWorkspaces.ts";
import "./WorkspaceSwitcher.css";

/**
 * The sidebar's workspace switcher (#50, `docs/ux/mockups/settings-first-run.html`): a button
 * naming the current workspace, opening a popover listing every workspace the user belongs to,
 * and "Workspace settings" (#52 gives it its first real destination, the categories screen;
 * only one settings section exists so far, so the button goes straight to it rather than an
 * empty settings shell with a single tab). "+ New workspace", also drawn in that mockup, stays
 * left out — that feature still has no screen, and a button that does nothing is worse than no
 * button.
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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
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
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate(`/${workspaceId}/settings/categories`);
            }}
          >
            {intl.formatMessage({ id: "workspaceSwitcher.settings", defaultMessage: "Workspace settings" })}
          </button>
        </div>
      )}
    </div>
  );
}
