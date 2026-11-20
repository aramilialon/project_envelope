import { isValidationError, MAX_NAME_LENGTH, parseAmount, TAX_REGIMES, type TaxRegime } from "@envelope/core";
import { useState, type FormEvent } from "react";
import { defineMessages, useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { ACCOUNT_TYPE_HINTS, ACCOUNT_TYPE_LABELS, TAX_REGIME_HINTS, TAX_REGIME_LABELS } from "./accountType.ts";
import { AccountTaxError, createAccount, type AccountTaxErrorCode, type AccountType } from "./api.ts";

const TYPES: readonly AccountType[] = ["checking", "savings", "cash", "credit_card", "brokerage"];

/** What the form says for each tax-settings code the API can return (#508). */
const TAX_ERROR_MESSAGES = defineMessages<AccountTaxErrorCode>({
  tax_regime_required: {
    id: "accounts.form.error.taxRegimeRequired",
    defaultMessage: "Choose this account's tax regime.",
  },
  tax_regime_not_applicable: {
    id: "accounts.form.error.taxRegimeNotApplicable",
    defaultMessage: "A tax regime applies only to a brokerage account in a workspace whose tax country is Italy.",
  },
  tax_regime_requires_withholding_agent: {
    id: "accounts.form.error.taxRegimeRequiresWithholdingAgent",
    defaultMessage: "An administered or managed account needs a broker that is an Italian withholding agent.",
  },
});

interface Props {
  readonly workspaceId: string;
  readonly baseCurrency: string;
  /** The workspace's tax country (#508): in "IT", a brokerage account asks for its tax regime and withholding agent. */
  readonly taxCountry: string | null;
  onClose(): void;
  onCreated(): void;
}

/**
 * The "+ Add account" form (#51, moved from the sidebar to the Accounts screen by #323), in the
 * shared `SideSheet`. No mockup draws this exact form — only the onboarding's first-account
 * step and the workspace-settings account list, each a different shape — so it is composed
 * from those same already-established pieces (`.types`/`.opt` radiogroup, `.field`, money
 * input) rather than inventing a new pattern.
 *
 * In a workspace whose tax country is Italy ("IT") only, a brokerage account also asks for its
 * tax regime (#508): a second `.types`/`.opt` radiogroup with no preselection, a one-line hint per
 * regime and one for the group, and — for a self-declared regime only — a `.chk` checkbox for
 * whether the broker is an Italian withholding agent. Neither appears anywhere else.
 */
export default function AddAccountForm({ workspaceId, baseCurrency, taxCountry, onClose, onCreated }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [onBudget, setOnBudget] = useState(true);
  const [owedStr, setOwedStr] = useState("");
  const [taxRegime, setTaxRegime] = useState<TaxRegime | "">("");
  const [withholdingAgent, setWithholdingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Whether on/off budget is even a choice: a checking, cash or credit card account is always
  // on budget and a brokerage account always off it (#74) — only a savings account (money set
  // aside, not necessarily budgeted day-to-day) leaves it up to the user (`#402`).
  const onBudgetEditable = type === "savings";
  const effectiveOnBudget = onBudgetEditable ? onBudget : type !== "brokerage";

  // Only an on-budget credit card has a payment category to seed: `apps/api`'s own
  // `createAccount` ignores `startingBalanceCents` for every other account type.
  const showOwed = type === "credit_card" && effectiveOnBudget;

  // The tax regime and withholding agent of a brokerage account (#508) are Italian rules today:
  // asked, and required, only in a workspace whose tax country is "IT". An administered or
  // managed account's broker is always an Italian withholding agent, so the question is asked
  // only for a self-declared one, and `true` is sent for the other two.
  const showTax = type === "brokerage" && taxCountry === "IT";
  const showWithholdingAgent = showTax && taxRegime === "self_declared";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    const trimmedName = name.trim();
    if (!accessToken || !trimmedName || (showTax && taxRegime === "")) {
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
        onBudget: effectiveOnBudget,
        ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
        ...(showTax && taxRegime !== ""
          ? { taxRegime, domesticWithholdingAgent: taxRegime === "self_declared" ? withholdingAgent : true }
          : {}),
      });
      onCreated();
    } catch (createError) {
      setError(
        createError instanceof AccountTaxError
          ? intl.formatMessage(TAX_ERROR_MESSAGES[createError.code])
          : intl.formatMessage({ id: "accounts.form.error", defaultMessage: "We could not create this account." }),
      );
      setSubmitting(false);
    }
  }

  return (
    <SideSheet title={intl.formatMessage({ id: "accounts.form.title", defaultMessage: "Add account" })} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="acc-name">{intl.formatMessage({ id: "accounts.form.name", defaultMessage: "Name" })}</label>
          <input id="acc-name" type="text" value={name} onChange={(event) => setName(event.target.value)} maxLength={MAX_NAME_LENGTH} required />
        </div>

        <fieldset className="types">
          <legend>{intl.formatMessage({ id: "accounts.form.type", defaultMessage: "Account type" })}</legend>
          {TYPES.map((t) => (
            <label className="opt" key={t}>
              <input
                type="radio"
                name="acc-type"
                value={t}
                checked={type === t}
                onChange={() => {
                  setType(t);
                  setError(null);
                }}
                aria-describedby={`acc-type-hint-${t}`}
              />
              <span>
                <b>{intl.formatMessage(ACCOUNT_TYPE_LABELS[t])}</b>
                {/* Not part of the radio's own accessible name (`aria-hidden`) — it is already
                    reachable as its accessible description, via `aria-describedby` above. */}
                <small id={`acc-type-hint-${t}`} aria-hidden="true">
                  {intl.formatMessage(ACCOUNT_TYPE_HINTS[t])}
                </small>
              </span>
            </label>
          ))}
        </fieldset>

        {onBudgetEditable && (
          <label className="chk">
            <input type="checkbox" checked={onBudget} onChange={(event) => setOnBudget(event.target.checked)} />
            {intl.formatMessage({ id: "accounts.form.onBudget", defaultMessage: "On budget" })}
          </label>
        )}

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

        {showTax && (
          <fieldset className="types" aria-describedby="acc-tax-regime-hint">
            <legend>{intl.formatMessage({ id: "accounts.form.taxRegime", defaultMessage: "Tax regime" })}</legend>
            <p className="hint" id="acc-tax-regime-hint">
              {intl.formatMessage({
                id: "accounts.form.taxRegime.hint",
                defaultMessage: "How gains on this account are taxed. Your broker's contract or tax statements say which one.",
              })}
            </p>
            {TAX_REGIMES.map((regime) => (
              <label className="opt" key={regime}>
                <input
                  type="radio"
                  name="acc-tax-regime"
                  value={regime}
                  checked={taxRegime === regime}
                  onChange={() => {
                    setTaxRegime(regime);
                    setError(null);
                  }}
                  aria-describedby={`acc-tax-regime-hint-${regime}`}
                />
                <span>
                  <b>{intl.formatMessage(TAX_REGIME_LABELS[regime])}</b>
                  <small id={`acc-tax-regime-hint-${regime}`} aria-hidden="true">
                    {intl.formatMessage(TAX_REGIME_HINTS[regime])}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {showWithholdingAgent && (
          <label className="chk">
            <input
              type="checkbox"
              checked={withholdingAgent}
              onChange={(event) => setWithholdingAgent(event.target.checked)}
              aria-describedby="acc-withholding-agent-hint"
            />
            <span>
              {intl.formatMessage({
                id: "accounts.form.withholdingAgent",
                defaultMessage: "The broker is an Italian withholding agent",
              })}
              <small id="acc-withholding-agent-hint" aria-hidden="true">
                {intl.formatMessage({
                  id: "accounts.form.withholdingAgent.hint",
                  defaultMessage: "It withholds Italian tax at source on dividends, coupons and fund income.",
                })}
              </small>
            </span>
          </label>
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
          <button type="submit" className="btn primary" disabled={submitting || !name.trim() || (showTax && taxRegime === "")}>
            {intl.formatMessage({ id: "accounts.form.submit", defaultMessage: "Add account" })}
          </button>
        </div>
      </form>
    </SideSheet>
  );
}
