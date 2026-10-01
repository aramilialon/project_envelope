import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useOutletContext, useParams } from "react-router-dom";

import { ACCOUNT_TYPE_LABELS } from "./accountType.ts";
import { closeAccount, type Account } from "./api.ts";
import type { AccountsState } from "./useAccounts.ts";
import "./AccountsScreen.css";

type Context = AccountsState & { refetch(): void };

/**
 * The "Accounts" screen (#51): the list behind the sidebar's own ledger, where an account is
 * closed. Creating one is the sidebar's "+ Add account" button (`AppLayout`), not duplicated
 * here, since it is meant to be reachable from every screen, not just this one. Reopening a
 * closed account has no endpoint yet (`apps/api`'s `closeAccount` is one-way), so closed
 * accounts are listed read-only.
 */
export default function AccountsScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const state = useOutletContext<Context>();
  const [closingId, setClosingId] = useState<string | null>(null);

  if (state.status === "loading") {
    return (
      <p role="status">{intl.formatMessage({ id: "accounts.loading", defaultMessage: "Loading your accounts…" })}</p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert">
        {intl.formatMessage({ id: "accounts.error", defaultMessage: "We could not load your accounts." })}
      </p>
    );
  }

  const open = state.accounts.filter((a) => a.closedAt === null);
  const closed = state.accounts.filter((a) => a.closedAt !== null);

  async function handleClose(account: Account) {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setClosingId(account.id);
    try {
      await closeAccount(accessToken, workspaceId!, account.id);
      state.refetch();
    } finally {
      setClosingId(null);
    }
  }

  return (
    <div className="accounts-screen">
      <h1>{intl.formatMessage({ id: "accounts.title", defaultMessage: "Accounts" })}</h1>

      {open.length === 0 ? (
        <p>{intl.formatMessage({ id: "accounts.empty", defaultMessage: "No accounts yet: add one from the sidebar." })}</p>
      ) : (
        <ul className="account-list">
          {open.map((account) => (
            <li key={account.id}>
              <span className="name">{account.name}</span>
              <span className="type">{intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}</span>
              <span className="budget">
                {account.onBudget
                  ? intl.formatMessage({ id: "accounts.onBudget", defaultMessage: "On budget" })
                  : intl.formatMessage({ id: "accounts.offBudget", defaultMessage: "Off budget" })}
              </span>
              <button
                type="button"
                className="plain danger"
                disabled={closingId === account.id}
                onClick={() => void handleClose(account)}
              >
                {intl.formatMessage({ id: "accounts.close", defaultMessage: "Close" })}
              </button>
            </li>
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <>
          <h2>{intl.formatMessage({ id: "accounts.closedTitle", defaultMessage: "Closed" })}</h2>
          <ul className="account-list closed">
            {closed.map((account) => (
              <li key={account.id}>
                <span className="name">{account.name}</span>
                <span className="type">{intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
