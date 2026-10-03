import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { runQuickAssign, type QuickAssignMode } from "./api.ts";
import "./QuickAssignPanel.css";

const MODES: readonly { mode: QuickAssignMode; label: string }[] = [
  { mode: "fund_targets", label: "Fund the targets" },
  { mode: "cover_overspending", label: "Cover overspending" },
  { mode: "cover_card_debt", label: "Cover the cards' debt" },
  { mode: "repeat_assigned", label: "As assigned last month" },
  { mode: "repeat_spent", label: "As spent last month" },
];

interface Props {
  readonly workspaceId: string;
  readonly month: string;
  readonly groups: readonly { id: string; name: string }[];
  onClose(): void;
  /** Called once the action ran — the budget month needs refetching. */
  onDone(): void;
}

/**
 * The "Quick assign" panel (#55, design.md): a scope (every category, or one group) and one of
 * the five modes `apps/api`'s own quick-assign endpoint already supports ("cover the scheduled
 * transactions", the mockup's sixth choice, has no endpoint yet — #19 left it for later). No
 * live preview of what each category would get, unlike the mockup: that needs computing every
 * affected category's own before/after, which the issue's own one-liner ("fund targets, or
 * repeat last month's assigned or spent amounts") does not ask for.
 */
export default function QuickAssignPanel({ workspaceId, month, groups, onClose, onDone }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [scopeGroupId, setScopeGroupId] = useState<string>("");
  const [mode, setMode] = useState<QuickAssignMode>("fund_targets");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await runQuickAssign(
        accessToken,
        workspaceId,
        month,
        scopeGroupId ? { kind: "group", groupId: scopeGroupId } : { kind: "all" },
        mode,
      );
      onDone();
    } catch {
      setError(intl.formatMessage({ id: "quickAssign.error", defaultMessage: "We could not run quick assign." }));
      setSubmitting(false);
    }
  }

  return (
    <SideSheet title={intl.formatMessage({ id: "quickAssign.title", defaultMessage: "Quick assign" })} onClose={onClose}>
      <form className="quick-assign-panel" onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="qa-scope">{intl.formatMessage({ id: "quickAssign.scope", defaultMessage: "Scope" })}</label>
          <select id="qa-scope" value={scopeGroupId} onChange={(event) => setScopeGroupId(event.target.value)}>
            <option value="">{intl.formatMessage({ id: "quickAssign.scope.all", defaultMessage: "All categories" })}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="types">
          <legend className="sr-only">{intl.formatMessage({ id: "quickAssign.mode", defaultMessage: "Mode" })}</legend>
          {MODES.map((m) => (
            <label className="opt" key={m.mode}>
              <input type="radio" name="qa-mode" checked={mode === m.mode} onChange={() => setMode(m.mode)} />
              <b>{m.label}</b>
            </label>
          ))}
        </fieldset>

        {error && (
          <p className="hint bad" role="alert">
            {error}
          </p>
        )}

        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>
            {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
          </button>
          <button type="submit" className="btn primary" disabled={submitting}>
            {intl.formatMessage({ id: "quickAssign.run", defaultMessage: "Run" })}
          </button>
        </div>
      </form>
    </SideSheet>
  );
}
