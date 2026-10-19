import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { deleteWorkspace } from "./api.ts";

interface Props {
  readonly workspaceId: string;
  readonly workspaceName: string;
  onClose(): void;
  onDeleted(): void;
}

/**
 * The owner-only danger zone (`#394`, the mockup's own `settings-first-run.html`: "type the
 * workspace's own name to confirm"): deletes the workspace and every piece of data in it,
 * forever, for every member — `apps/api`'s own cascade (migration 0008) does the actual removal
 * in one shot. The confirm button stays disabled until the typed text matches the name exactly,
 * the same guard the mockup itself draws.
 */
export default function DeleteWorkspaceForm({ workspaceId, workspaceName, onClose, onDeleted }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    if (!accessToken || confirmText !== workspaceName) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await deleteWorkspace(accessToken, workspaceId);
      onDeleted();
    } catch {
      setError(intl.formatMessage({ id: "workspaces.delete.error", defaultMessage: "We could not delete this workspace." }));
      setSubmitting(false);
    }
  }

  return (
    <SideSheet title={intl.formatMessage({ id: "workspaces.delete.title", defaultMessage: "Delete the workspace" })} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <p className="hint">
          {intl.formatMessage({
            id: "workspaces.delete.warning",
            defaultMessage: "Permanently deletes the workspace and all its data, for every member.",
          })}
        </p>
        <div className="field">
          <label htmlFor="ws-del-confirm">
            {intl.formatMessage(
              { id: "workspaces.delete.confirmLabel", defaultMessage: "To confirm, type {name}" },
              { name: workspaceName },
            )}
          </label>
          <input
            id="ws-del-confirm"
            type="text"
            autoComplete="off"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>

        {error && (
          <p className="hint bad" role="alert">
            {error}
          </p>
        )}

        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>
            {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
          </button>
          <button type="submit" className="btn bad" disabled={submitting || confirmText !== workspaceName}>
            {intl.formatMessage({ id: "workspaces.delete.submit", defaultMessage: "Delete the workspace" })}
          </button>
        </div>
      </form>
    </SideSheet>
  );
}
