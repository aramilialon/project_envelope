import { formatMoney } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useNavigate, useParams } from "react-router-dom";

import { tooManyRequestsMessage } from "../apiErrors.ts";
import { shortDate } from "../format.ts";
import { todayIsoIn } from "../workspaceDate.ts";
import { usePhoneWidth } from "../layout/usePhoneWidth.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { ACCOUNT_TYPE_LABELS } from "./accountType.ts";
import AddAccountForm from "./AddAccountForm.tsx";
import { AccountNotEmptyError, closeAccount, type Account } from "./api.ts";
import { useAccountBalances } from "./useAccountBalances.ts";
import { useAccounts } from "./useAccounts.ts";
import "./AccountsScreen.css";

/** Why an account could not be closed: a message, and under it, for an account not empty, each reason. */
interface CloseRefusal {
  readonly accountId: string;
  readonly message: string;
  readonly reasons: readonly string[];
}

/**
 * The "Accounts" screen (#51): list, create, close an account. Fetches its own data (`#323`
 * removed the band's old account ledger and its shared fetch along with it — nothing else
 * needs this data now, so there is no reason to lift it back into `AppLayout`). An open
 * account's own name opens its register (`#54`); reopening a closed one has no endpoint yet, so
 * closed accounts are listed read-only. Each row's own balance (`#333`) is not part of the
 * `Account` shape the API returns — there is no bulk endpoint for it yet — so it is fetched
 * separately, the same balance as of today the register itself computes (#702), and rendered
 * once it resolves. When the API refuses to close an account that is not empty today and later
 * (`#703`, `#729`), the reasons are shown under that account's row, where its "Close" button is.
 */
export default function AccountsScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const navigate = useNavigate();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspaces = useWorkspaces();
  const state = useAccounts(workspaceId!);
  const isPhone = usePhoneWidth();
  const timeZone = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId)?.timeZone : undefined;
  // Today's balance in the workspace's time zone (#702): rows dated later count in none.
  const balances = useAccountBalances(workspaceId!, auth.user?.access_token, state.status === "ok" ? state.accounts : [], timeZone);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeRefusal, setCloseRefusal] = useState<CloseRefusal | null>(null);
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
    // While its request runs, Close stays focusable (`aria-disabled`, not `disabled`, so focus does
    // not fall to the page and back to its top) and a second press does nothing.
    if (!accessToken || closingId === account.id) {
      return;
    }
    setClosingId(account.id);
    setCloseRefusal(null);
    try {
      await closeAccount(accessToken, workspaceId!, account.id);
      state.refetch();
    } catch (caught) {
      setCloseRefusal(closeRefusalOf(caught, account));
    } finally {
      setClosingId(null);
    }
  }

  /**
   * Why closing failed, in plain words (#703, #729): what keeps the account from being empty today
   * and later, each reason a sentence of its own with the figures the screen shows, or a generic
   * failure with no reasons.
   */
  function closeRefusalOf(caught: unknown, account: Account): CloseRefusal {
    const failed: CloseRefusal = {
      accountId: account.id,
      message:
        tooManyRequestsMessage(intl, caught) ??
        intl.formatMessage({ id: "accounts.closeError", defaultMessage: "We could not close this account." }),
      reasons: [],
    };
    if (!(caught instanceof AccountNotEmptyError)) {
      return failed;
    }
    const { balanceCents, laterRows, holdsPositions, scheduled } = caught.details;
    // A date in the workspace's own year shows no year (#702).
    const currentYear = timeZone === undefined ? undefined : Number(todayIsoIn(timeZone).slice(0, 4));
    const reasons: string[] = [];
    if (balanceCents !== 0) {
      reasons.push(
        intl.formatMessage(
          { id: "accounts.closeRefused.balanceToday", defaultMessage: "Its balance today is {balance}." },
          { balance: money(balanceCents, account.currency) },
        ),
      );
    }
    if (laterRows.count > 0 && laterRows.firstDate !== null) {
      const values = { count: laterRows.count, firstDate: shortDate(laterRows.firstDate, intl.locale, currentYear) };
      // Only a brokerage account has trades of its own that move no cash.
      reasons.push(
        account.type === "brokerage"
          ? intl.formatMessage(
              {
                id: "accounts.closeRefused.laterRowsWithTrades",
                defaultMessage:
                  "{count, plural, one {A transaction or trade is dated after today, on {firstDate}.} other {# transactions or trades are dated after today, the first on {firstDate}.}}",
              },
              values,
            )
          : intl.formatMessage(
              {
                id: "accounts.closeRefused.laterRows",
                defaultMessage:
                  "{count, plural, one {A transaction is dated after today, on {firstDate}.} other {# transactions are dated after today, the first on {firstDate}.}}",
              },
              values,
            ),
      );
    }
    if (holdsPositions) {
      reasons.push(intl.formatMessage({ id: "accounts.closeRefused.holdsSecurities", defaultMessage: "It holds securities today." }));
    }
    if (scheduled.count > 0 && scheduled.nextDueDate !== null) {
      // The due date lets the user find the schedule (#741).
      reasons.push(
        intl.formatMessage(
          {
            id: "accounts.closeRefused.scheduledDue",
            defaultMessage:
              "{count, plural, one {A transaction scheduled for {date} uses it.} other {# scheduled transactions use it, the first on {date}.}}",
          },
          { count: scheduled.count, date: shortDate(scheduled.nextDueDate, intl.locale, currentYear) },
        ),
      );
    } else if (scheduled.count > 0) {
      // An API older than #741 sends no due date.
      reasons.push(
        intl.formatMessage(
          {
            id: "accounts.closeRefused.scheduled",
            defaultMessage: "{count, plural, one {A scheduled transaction uses it.} other {# scheduled transactions use it.}}",
          },
          { count: scheduled.count },
        ),
      );
    }
    if (reasons.length === 0) {
      // A refusal that names no reason the screen knows of: say only that the close failed.
      return failed;
    }
    return {
      accountId: account.id,
      message: intl.formatMessage({ id: "accounts.closeRefused.intro", defaultMessage: "This account can't be closed yet. Right now:" }),
      reasons,
    };
  }

  /** The refusal under an account's row, where its Close button is. */
  function refusalFor(account: Account) {
    return closeRefusal?.accountId === account.id ? (
      <div className="hint bad close-refusal" role="alert">
        <p>{closeRefusal.message}</p>
        {closeRefusal.reasons.length > 0 ? (
          <ul>
            {closeRefusal.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
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
            <div key={account.id} className="ph-acc">
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
                aria-disabled={closingId === account.id}
                onClick={() => void handleClose(account)}
              >
                {intl.formatMessage({ id: "accounts.close", defaultMessage: "Close" })}
              </button>
              {refusalFor(account)}
            </div>
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
                aria-disabled={closingId === account.id}
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
