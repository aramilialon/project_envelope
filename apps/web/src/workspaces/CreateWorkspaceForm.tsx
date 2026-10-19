import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { createWorkspace, type Workspace } from "./api.ts";

/** The onboarding mockup's own four choices (`settings-first-run.html`'s "o-cur" select) — not every ISO 4217 code, a short, deliberate list. */
const CURRENCIES: readonly { readonly code: string; readonly label: string }[] = [
  { code: "EUR", label: "Euro (EUR)" },
  { code: "CHF", label: "Swiss franc (CHF)" },
  { code: "GBP", label: "Pound sterling (GBP)" },
  { code: "USD", label: "US dollar (USD)" },
];

/** The same mockup's own "o-zone" select — a short list of representative zones, not every IANA name. */
const TIME_ZONES: readonly string[] = ["Europe/Rome", "Europe/London", "Europe/Berlin", "America/New_York", "Asia/Tokyo"];

interface Props {
  onClose(): void;
  onCreated(workspace: Workspace): void;
}

/**
 * A workspace's own name, currency and time zone (`#394`, the onboarding mockup's own step 2,
 * `settings-first-run.html`) — reused both for a brand new, zero-membership user (`WorkspaceGate`)
 * and for "+ New workspace" in the switcher (`WorkspaceSwitcher`). The currency cannot change
 * after creation (design.md, "Onboarding": accounts in other currencies convert into it), so it
 * is asked for upfront and never offered again.
 */
export default function CreateWorkspaceForm({ onClose, onCreated }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [name, setName] = useState("");
  const [baseCurrency, setBaseCurrency] = useState(CURRENCIES[0]!.code);
  const [timeZone, setTimeZone] = useState(TIME_ZONES[0]!);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    const trimmedName = name.trim();
    if (!accessToken || !trimmedName) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await createWorkspace(accessToken, { name: trimmedName, baseCurrency, timeZone });
      onCreated(workspace);
    } catch {
      setError(intl.formatMessage({ id: "workspaces.form.error", defaultMessage: "We could not create this workspace." }));
      setSubmitting(false);
    }
  }

  return (
    <SideSheet title={intl.formatMessage({ id: "workspaces.form.title", defaultMessage: "New workspace" })} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="ws-name">{intl.formatMessage({ id: "workspaces.form.name", defaultMessage: "Name" })}</label>
          <input id="ws-name" type="text" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>

        <div className="field">
          <label htmlFor="ws-currency">{intl.formatMessage({ id: "workspaces.form.currency", defaultMessage: "Currency" })}</label>
          <select id="ws-currency" value={baseCurrency} onChange={(event) => setBaseCurrency(event.target.value)}>
            {CURRENCIES.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.label}
              </option>
            ))}
          </select>
          <p className="hint">
            {intl.formatMessage({ id: "workspaces.form.currency.hint", defaultMessage: "Chosen now, and never changed later." })}
          </p>
        </div>

        <div className="field">
          <label htmlFor="ws-timezone">{intl.formatMessage({ id: "workspaces.form.timeZone", defaultMessage: "Time zone" })}</label>
          <select id="ws-timezone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className="hint">
            {intl.formatMessage({
              id: "workspaces.form.timeZone.hint",
              defaultMessage: "Decides which month a transaction belongs to, the same for every member.",
            })}
          </p>
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
          <button type="submit" className="btn primary" disabled={submitting || !name.trim()}>
            {intl.formatMessage({ id: "workspaces.form.submit", defaultMessage: "Create workspace" })}
          </button>
        </div>
      </form>
    </SideSheet>
  );
}
