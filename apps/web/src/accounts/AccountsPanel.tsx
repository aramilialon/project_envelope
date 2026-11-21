import { formatMoney, groupAccountsForPanel } from "@envelope/core";
import { useEffect } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { Link, useNavigate } from "react-router-dom";

import { tooManyRequestsMessage } from "../apiErrors.ts";
import type { Account } from "./api.ts";
import { useAccountBalances } from "./useAccountBalances.ts";
import { useAccounts } from "./useAccounts.ts";
import { useHoldsSecurities } from "./useHoldsSecurities.ts";
import "./AccountsPanel.css";

export interface AccountsPanelProps {
  readonly workspaceId: string;
  /** The workspace's base currency, the net worth's own; each account's balance is in its own currency. */
  readonly currency: string;
  /** The workspace's time zone, where "today" is drawn for every balance (#702); the browser's own until it loads. */
  readonly timeZone: string | undefined;
  /** The account whose register the main content shows right now, marked current in the list. */
  readonly currentAccountId: string | undefined;
  /** Re-reads every balance when it changes: a different screen, or a transaction just recorded. */
  readonly refreshKey: string;
  readonly onClose: () => void;
}

/**
 * The accounts panel (#412, `docs/ux/mockups/accounts-panel.html`, design.md's "Band"): a
 * dismissible left panel opened from the band's own toggle, over whichever screen is showing —
 * deliberately not the persistent sidebar `#323` removed, so it is closed by default and mounted
 * only while open (every balance is fresh each time it opens). The workspace's net worth at its
 * head, then on-budget accounts, credit cards and off-budget accounts, each a row that switches
 * the main content to that account's own register without closing the panel; a link at its foot
 * goes to the full Accounts screen. Open accounts only: a closed one is neither listed nor counted,
 * the same as the Accounts screen's own list above its "Closed" section. Not a dialog: nothing
 * else on the page is blocked while it is open, so there is no focus trap — Escape and its own
 * "Close" button both dismiss it. Each balance is shown in its account's own currency, and the net
 * worth adds up the base-currency ones only (#652), each as of today (#702): a note under it lists what other currencies
 * hold, each in its own, and another says securities are not included whenever a brokerage
 * account holds some; both notes show only once the net worth itself does, until exchange rates
 * (#86) and prices (#125) exist.
 */
export default function AccountsPanel({ workspaceId, currency, timeZone, currentAccountId, refreshKey, onClose }: AccountsPanelProps) {
  const intl = useIntl();
  const auth = useAuth();
  const navigate = useNavigate();
  const state = useAccounts(workspaceId);
  const open = state.status === "ok" ? state.accounts.filter((a) => a.closedAt === null) : [];
  const balances = useAccountBalances(workspaceId, auth.user?.access_token, open, timeZone, refreshKey);
  const holdsSecurities = useHoldsSecurities(workspaceId, auth.user?.access_token, open, refreshKey);
  const money = (cents: number, inCurrency: string) => formatMoney(cents, { locale: intl.locale, currency: inCurrency });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Every row shows as soon as the account list itself arrives; amounts, and the net worth (only
  // meaningful once every balance is in), fill in when the balances do.
  const allBalancesKnown = open.every((a) => a.id in balances);
  const groups = groupAccountsForPanel(
    open.map((account) => ({
      account,
      id: account.id,
      isCard: account.type === "credit_card",
      onBudget: account.onBudget,
      balance: balances[account.id] ?? 0,
      currency: account.currency,
    })),
    currency,
  );
  const netWorthKnown = state.status === "ok" && allBalancesKnown;

  function section(title: string, rows: readonly { account: Account }[]) {
    if (rows.length === 0) {
      return null;
    }
    return (
      <section className="accl-sec" aria-label={title}>
        <h3>{title}</h3>
        {rows.map(({ account }) => {
          const balance = balances[account.id];
          return (
            <button
              key={account.id}
              type="button"
              className="acc-row"
              aria-current={account.id === currentAccountId ? "true" : undefined}
              onClick={() => navigate(`/${workspaceId}/accounts/${account.id}`)}
            >
              <span className="cn">
                <b>{account.name}</b>
                {!account.onBudget && <small>{intl.formatMessage({ id: "accountsPanel.offBudgetTag", defaultMessage: "off budget" })}</small>}
              </span>
              <span className={`n${balance !== undefined && balance < 0 ? " neg" : ""}`}>{balance === undefined ? "" : money(balance, account.currency)}</span>
            </button>
          );
        })}
      </section>
    );
  }

  return (
    <aside id="accounts-panel" className="accl" aria-label={intl.formatMessage({ id: "accountsPanel.label", defaultMessage: "Accounts" })}>
      <div className="accl-head">
        <button type="button" className="plain accl-close" onClick={onClose}>
          {intl.formatMessage({ id: "accountsPanel.close", defaultMessage: "× Close" })}
        </button>
        <div className="where">{intl.formatMessage({ id: "accountsPanel.label", defaultMessage: "Accounts" })}</div>
        <h2>{intl.formatMessage({ id: "accountsPanel.netWorth", defaultMessage: "Net worth" })}</h2>
        <span className="big n">{netWorthKnown ? money(groups.netWorth, currency) : ""}</span>
        {netWorthKnown && groups.excluded.length > 0 && (
          <p className="nw-note">
            {intl.formatMessage(
              { id: "accountsPanel.netWorth.otherCurrencies", defaultMessage: "Not included: {amounts} (no exchange rates yet)" },
              { amounts: intl.formatList(groups.excluded.map((e) => money(e.amount, e.currency)), { type: "conjunction" }) },
            )}
          </p>
        )}
        {netWorthKnown && holdsSecurities && (
          <p className="nw-note">
            {intl.formatMessage({ id: "accountsPanel.netWorth.noSecurities", defaultMessage: "Net worth does not include securities (no prices yet)" })}
          </p>
        )}
      </div>

      {state.status === "loading" && (
        <p className="accl-note" role="status">
          {intl.formatMessage({ id: "accounts.loading", defaultMessage: "Loading your accounts…" })}
        </p>
      )}
      {state.status === "error" && (
        <p className="accl-note" role="alert">
          {tooManyRequestsMessage(intl, state.error) ?? intl.formatMessage({ id: "accounts.error", defaultMessage: "We could not load your accounts." })}
        </p>
      )}
      {state.status === "ok" && open.length === 0 && (
        <p className="accl-note">{intl.formatMessage({ id: "accountsPanel.empty", defaultMessage: "No accounts yet." })}</p>
      )}

      {section(intl.formatMessage({ id: "accountsPanel.onBudget", defaultMessage: "On budget" }), groups.onBudget)}
      {section(intl.formatMessage({ id: "accountsPanel.cards", defaultMessage: "Credit cards" }), groups.cards)}
      {section(intl.formatMessage({ id: "accountsPanel.offBudget", defaultMessage: "Off budget" }), groups.offBudget)}

      <div className="accl-foot">
        <Link className="plain" to={`/${workspaceId}/accounts`}>
          {intl.formatMessage({ id: "accountsPanel.toAccountsScreen", defaultMessage: "Go to the Accounts screen →" })}
        </Link>
      </div>
    </aside>
  );
}
