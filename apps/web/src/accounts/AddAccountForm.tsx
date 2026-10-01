import { isValidationError, parseAmount } from "@envelope/core";
import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { ACCOUNT_TYPE_LABELS } from "./accountType.ts";
import { createAccount, type AccountType } from "./api.ts";

const TYPES: readonly AccountType[] = ["checking", "savings", "cash", "credit_card"];

interface Props {
  readonly workspaceId: string;
  readonly baseCurrency: string;
  onClose(): void;
  onCreated(): void;
}

/**
 * The "+ Add account" form (#51, moved from the sidebar to the Accounts screen by #323), in the
 * shared `SideSheet`. No mockup draws this exact form — only the onboarding's first-account
 * step and the workspace-settings account list, each a different shape — so it is composed
 * from those same already-established pieces (`.types`/`.opt` radiogroup, `.field`, money
 * input) rather than inventing a new pattern.
 */
export default function AddAccountForm({ workspaceId, baseCurrency, onClose, onCreated }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [onBudget, setOnBudget] = useState(true);
  const [owedStr, setOwedStr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Only an on-budget credit card has a payment category to seed: `apps/api`'s own
  // `createAccount` ignores `startingBalanceCents` for every other account type.
  const showOwed = type === "credit_card" && onBudget;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    const trimmedName = name.trim();
    if (!accessToken || !trimmedName) {
      return;
    }

    let startingBalanceCents: number | undefined;
    if (showOwed && owedStr.trim() !== "") {
      try {
        const owed = parseAmount(owedStr, { locale: intl.locale, currency: baseCurrency });
        startingBalanceCents = owed === 0 ? 0 : -owed;
      } catch (parseError) {
        if (isValidationError(parseError, "invalid_amount_format")) {
          setError(intl.formatMessage({ id: "accounts.form.invalidAmount", defaultMessage: "Enter a valid amount." }));
          return;
        }
        throw parseError;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      await createAccount(accessToken, workspaceId, {
        name: trimmedName,
        type,
        currency: baseCurrency,
        onBudget,
        ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
      });
      onCreated();
    } catch {
      setError(intl.formatMessage({ id: "accounts.form.error", defaultMessage: "We could not create this account." }));
      setSubmitting(false);
    }
  }

  return (
    <SideSheet title={intl.formatMessage({ id: "accounts.form.title", defaultMessage: "Add account" })} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="acc-name">{intl.formatMessage({ id: "accounts.form.name", defaultMessage: "Name" })}</label>
          <input id="acc-name" type="text" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>

        <fieldset className="types">
          <legend>{intl.formatMessage({ id: "accounts.form.type", defaultMessage: "Account type" })}</legend>
          {TYPES.map((t) => (
            <label className="opt" key={t}>
              <input type="radio" name="acc-type" value={t} checked={type === t} onChange={() => setType(t)} />
              <b>{intl.formatMessage(ACCOUNT_TYPE_LABELS[t])}</b>
            </label>
          ))}
        </fieldset>

        <label className="chk">
          <input type="checkbox" checked={onBudget} onChange={(event) => setOnBudget(event.target.checked)} />
          {intl.formatMessage({ id: "accounts.form.onBudget", defaultMessage: "On budget" })}
        </label>

        {showOwed && (
          <div className="field">
            <label htmlFor="acc-owed">
              {intl.formatMessage({
                id: "accounts.form.owed",
                defaultMessage: "How much do you currently owe on this card?",
              })}
            </label>
            <input
              id="acc-owed"
              type="text"
              inputMode="decimal"
              value={owedStr}
              onChange={(event) => setOwedStr(event.target.value)}
              placeholder="0.00"
            />
          </div>
        )}

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
            {intl.formatMessage({ id: "accounts.form.submit", defaultMessage: "Add account" })}
          </button>
        </div>
      </form>
    </SideSheet>
  );
}
