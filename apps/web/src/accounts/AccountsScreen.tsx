import { formatMoney } from "@envelope/core";
import { Fragment, useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useNavigate, useParams } from "react-router-dom";

import { tooManyRequestsMessage } from "../apiErrors.ts";
import { usePhoneWidth } from "../layout/usePhoneWidth.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { ACCOUNT_TYPE_LABELS } from "./accountType.ts";
import AddAccountForm from "./AddAccountForm.tsx";
import { AccountNotEmptyError, closeAccount, type Account } from "./api.ts";
import { useAccountBalances } from "./useAccountBalances.ts";
import { useAccounts } from "./useAccounts.ts";
import "./AccountsScreen.css";

/**
 * The "Accounts" screen (#51): list, create, close an account. Fetches its own data (`#323`
 * removed the band's old account ledger and its shared fetch along with it — nothing else
 * needs this data now, so there is no reason to lift it back into `AppLayout`). An open
 * account's own name opens its register (`#54`); reopening a closed one has no endpoint yet, so
 * closed accounts are listed read-only. Each row's own balance (`#333`) is not part of the
 * `Account` shape the API returns — there is no bulk endpoint for it yet — so it is fetched
 * separately, the same sum the register itself computes, and rendered once it resolves. When the
 * API refuses to close an account that still holds money or securities (`#703`), the reason is
 * shown under that account's row, where its "Close" button is.
 */
export default function AccountsScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const navigate = useNavigate();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspaces = useWorkspaces();
  const state = useAccounts(workspaceId!);
  const isPhone = usePhoneWidth();
  const balances = useAccountBalances(workspaceId!, auth.user?.access_token, state.status === "ok" ? state.accounts : []);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeRefusal, setCloseRefusal] = useState<{ readonly accountId: string; readonly message: string } | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);

  if (state.status === "loading") {
    return (
      <p role="status">{intl.formatMessage({ id: "accounts.loading", defaultMessage: "Loading your accounts…" })}</p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert">
        {tooManyRequestsMessage(intl, state.error) ?? intl.formatMessage({ id: "accounts.error", defaultMessage: "We could not load your accounts." })}
      </p>
    );
  }

  const open = state.accounts.filter((a) => a.closedAt === null);
  const closed = state.accounts.filter((a) => a.closedAt !== null);
  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  // Each balance in its account's own currency (#652): an off-budget account may be in another one than the workspace's.
  const money = (cents: number, currency: string) => formatMoney(cents, { locale: intl.locale, currency });

  async function handleClose(account: Account) {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setClosingId(account.id);
    setCloseRefusal(null);
    try {
      await closeAccount(accessToken, workspaceId!, account.id);
      state.refetch();
    } catch (caught) {
      setCloseRefusal({ accountId: account.id, message: closeRefusalMessage(caught, account.currency) });
    } finally {
      setClosingId(null);
    }
  }

  /** Why closing failed, in plain words: the balance and the securities still in it (#703), or a generic failure. */
  function closeRefusalMessage(caught: unknown, currency: string): string {
    if (caught instanceof AccountNotEmptyError) {
      const balance = money(caught.balanceCents, currency);
      if (caught.holdsPositions && caught.balanceCents !== 0) {
        return intl.formatMessage(
          {
            id: "accounts.closeRefused.balanceAndSecurities",
            defaultMessage:
              "This account still has a balance of {balance} and holds securities. An account can be closed once its balance is zero and it holds no securities.",
          },
          { balance },
        );
      }
      if (caught.holdsPositions) {
        return intl.formatMessage({
          id: "accounts.closeRefused.securities",
          defaultMessage: "This account still holds securities. An account can be closed once it holds none.",
        });
      }
      return intl.formatMessage(
        {
          id: "accounts.closeRefused.balance",
          defaultMessage: "This account still has a balance of {balance}. An account can be closed once its balance is zero.",
        },
        { balance },
      );
    }
    return (
      tooManyRequestsMessage(intl, caught) ??
      intl.formatMessage({ id: "accounts.closeError", defaultMessage: "We could not close this account." })
    );
  }

  /** The refusal under an account's row, where its Close button is. */
  function refusalFor(account: Account) {
    return closeRefusal?.accountId === account.id ? (
      <p className="hint bad close-refusal" role="alert">
        {closeRefusal.message}
      </p>
    ) : null;
  }

  return (
    <div className="accounts-screen">
      <h1>{intl.formatMessage({ id: "accounts.title", defaultMessage: "Accounts" })}</h1>

      {open.length === 0 ? (
        <p>{intl.formatMessage({ id: "accounts.empty", defaultMessage: "No accounts yet: add one below." })}</p>
      ) : isPhone ? (
        <div className="ph-accounts">
          {open.map((account) => (
            <Fragment key={account.id}>
              <div className="ph-acc">
                <button
                  type="button"
                  className="open"
                  onClick={() => navigate(`/${workspaceId}/accounts/${account.id}`)}
                >
                  <span>
                    {account.name}
                    <small>
                      {intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}
                      {" · "}
                      {account.onBudget
                        ? intl.formatMessage({ id: "accounts.onBudget", defaultMessage: "On budget" })
                        : intl.formatMessage({ id: "accounts.offBudget", defaultMessage: "Off budget" })}
                    </small>
                  </span>
                  <span className={`n${(balances[account.id] ?? 0) > 0 ? " in" : ""}`}>
                    {account.id in balances ? money(balances[account.id]!, account.currency) : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="close"
                  disabled={closingId === account.id}
                  onClick={() => void handleClose(account)}
                >
                  {intl.formatMessage({ id: "accounts.close", defaultMessage: "Close" })}
                </button>
              </div>
              {refusalFor(account)}
            </Fragment>
          ))}
        </div>
      ) : (
        <ul className="account-list">
          {open.map((account) => (
            <li key={account.id}>
              <button type="button" className="open-row" onClick={() => navigate(`/${workspaceId}/accounts/${account.id}`)}>
                {account.name}
              </button>
              <span className="type">{intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}</span>
              <span className="budget">
                {account.onBudget
                  ? intl.formatMessage({ id: "accounts.onBudget", defaultMessage: "On budget" })
                  : intl.formatMessage({ id: "accounts.offBudget", defaultMessage: "Off budget" })}
              </span>
              <span className={`n${(balances[account.id] ?? 0) > 0 ? " in" : ""}`}>
                {account.id in balances ? money(balances[account.id]!, account.currency) : ""}
              </span>
              <button
                type="button"
                className="plain danger"
                disabled={closingId === account.id}
                onClick={() => void handleClose(account)}
              >
                {intl.formatMessage({ id: "accounts.close", defaultMessage: "Close" })}
              </button>
              {refusalFor(account)}
            </li>
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <>
          <h2>{intl.formatMessage({ id: "accounts.closedTitle", defaultMessage: "Closed" })}</h2>
          {isPhone ? (
            <div className="ph-accounts">
              {closed.map((account) => (
                <div key={account.id} className="ph-acc static">
                  <span>
                    {account.name}
                    <small>{intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}</small>
                  </span>
                  <span className={`n${(balances[account.id] ?? 0) > 0 ? " in" : ""}`}>
                    {account.id in balances ? money(balances[account.id]!, account.currency) : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <ul className="account-list closed">
              {closed.map((account) => (
                <li key={account.id}>
                  <span className="name">{account.name}</span>
                  <span className="type">{intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}</span>
                  <span className={`n${(balances[account.id] ?? 0) > 0 ? " in" : ""}`}>
                    {account.id in balances ? money(balances[account.id]!, account.currency) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <button type="button" className="plain" onClick={() => setAddingAccount(true)}>
        {intl.formatMessage({ id: "layout.addAccount", defaultMessage: "+ Add account" })}
      </button>

      {addingAccount && currentWorkspace && (
        <AddAccountForm
          workspaceId={workspaceId!}
          baseCurrency={currentWorkspace.baseCurrency}
          taxCountry={currentWorkspace.taxCountry}
          onClose={() => setAddingAccount(false)}
          onCreated={() => {
            setAddingAccount(false);
            state.refetch();
          }}
        />
      )}
    </div>
  );
}
