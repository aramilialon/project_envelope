import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useNavigate, useParams } from "react-router-dom";

import CreateWorkspaceForm from "./CreateWorkspaceForm.tsx";
import DeleteWorkspaceForm from "./DeleteWorkspaceForm.tsx";
import { clearLastUsedWorkspaceId, setLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import { useWorkspaces } from "./useWorkspaces.ts";
import "./WorkspaceSwitcher.css";

type Sheet = "create" | "delete" | null;

/**
 * The sidebar's workspace switcher (#50, `docs/ux/mockups/settings-first-run.html`): a button
 * naming the current workspace, opening a popover listing every workspace the user belongs to,
 * "+ New workspace" (`#394`, opens `CreateWorkspaceForm`), "Delete workspace" (`#394`, owner-only,
 * opens `DeleteWorkspaceForm`) and "Workspace settings" (#52 gives it its first real destination,
 * the categories screen; only one settings section exists so far, so the button goes straight to
 * it rather than an empty settings shell with a single tab).
 */
export default function WorkspaceSwitcher() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const state = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const intl = useIntl();
  const navigate = useNavigate();
  const auth = useAuth();

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
          <path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
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
                const subject = auth.user?.profile?.sub;
                if (subject) {
                  setLastUsedWorkspaceId(subject, workspace.id);
                }
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
              setSheet("create");
            }}
          >
            {intl.formatMessage({ id: "workspaceSwitcher.new", defaultMessage: "+ New workspace" })}
          </button>
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
          {current?.role === "owner" && (
            <>
              <hr />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setOpen(false);
                  setSheet("delete");
                }}
              >
                {intl.formatMessage({ id: "workspaceSwitcher.delete", defaultMessage: "Delete workspace" })}
              </button>
            </>
          )}
        </div>
      )}
      {sheet === "create" && (
        <CreateWorkspaceForm
          onClose={() => setSheet(null)}
          onCreated={(workspace) => {
            setSheet(null);
            state.refetch();
            const subject = auth.user?.profile?.sub;
            if (subject) {
              setLastUsedWorkspaceId(subject, workspace.id);
            }
            navigate(`/${workspace.id}`);
          }}
        />
      )}
      {sheet === "delete" && current && (
        <DeleteWorkspaceForm
          workspaceId={current.id}
          workspaceName={current.name}
          onClose={() => setSheet(null)}
          onDeleted={() => {
            setSheet(null);
            const subject = auth.user?.profile?.sub;
            if (subject) {
              clearLastUsedWorkspaceId(subject);
            }
            navigate("/", { replace: true });
          }}
        />
      )}
    </div>
  );
}
